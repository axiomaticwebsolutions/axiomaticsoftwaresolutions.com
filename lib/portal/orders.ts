/**
 * Orders & invoices of the active business account (portal Orders page and the accountant CSV; decisions.md Phase 5,
 * api-contracts section 5). Only orders whose accountId is the account are listed: claimed guest checkouts count
 * (decisions.md section 1), unclaimed ones (accountId null) never do. 8 per page; search by order id or invoice number;
 * status filter All / Paid / Refunded / Pending / Failed / Canceled; sort by date (default newest first), status or
 * total. The CSV ("Export for accountant") holds every filtered order with the GST split in rupees (2 decimals) and
 * IST dates. Amounts come from the order snapshot, never from current prices.
 */
import "server-only";
import { OrderStatus, type ItemKind, type Prisma } from "@/generated/prisma/client";
import { csvRow, CSV_BOM, CSV_EOL, type CsvColumn, type CsvValue } from "@/lib/csv";
import { istParts } from "@/lib/dates";
import type { Db } from "@/lib/db";
import { paiseToDecimalString } from "@/lib/money";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { ORDERS_PAGE_SIZE, type OrderListQuery, type OrderStatusFilter } from "@/lib/validation/portal";
import type { BadgeTone } from "./billing";

/** Rows in one CSV export; larger accounts narrow the filters (the file ends with a note row when cut). */
export const ORDERS_EXPORT_LIMIT = 10_000;
export const ORDERS_CSV_FILE_NAME = "orders.csv";
export const GUEST_CHECKOUT_LABEL = "Guest checkout";

/** Order badges (prototype OB map; "Partly refunded" is new copy matching the order page). */
export const ORDER_STATUS_BADGES: Readonly<Record<OrderStatus, { label: string; tone: BadgeTone }>> = Object.freeze({
  PAID: { label: "Paid", tone: "sage" },
  REFUNDED: { label: "Refunded", tone: "lavender" },
  PARTIALLY_REFUNDED: { label: "Partly refunded", tone: "lavender" },
  FAILED: { label: "Failed", tone: "pink" },
  PENDING: { label: "Pending", tone: "peach" },
  CONFIRMING: { label: "Confirming", tone: "blue" },
  CANCELED: { label: "Canceled", tone: "slate" },
  AWAITING_PAYMENT: { label: "Unpaid", tone: "slate" },
  REVIEW: { label: "In review", tone: "peach" },
});

/** Status filter -> stored statuses. "Pending" covers every order still waiting on a payment or a check. */
export const ORDER_STATUS_FILTER_STATUSES: Readonly<Record<Exclude<OrderStatusFilter, "all">, readonly OrderStatus[]>> = Object.freeze({
  paid: [OrderStatus.PAID],
  refunded: [OrderStatus.REFUNDED, OrderStatus.PARTIALLY_REFUNDED],
  pending: [OrderStatus.AWAITING_PAYMENT, OrderStatus.CONFIRMING, OrderStatus.PENDING, OrderStatus.REVIEW],
  failed: [OrderStatus.FAILED],
  canceled: [OrderStatus.CANCELED],
});

export type AccountOrderItem = { productId: string; productShortName: string; planName: string; qty: number; kind: ItemKind };

export type AccountOrderRow = {
  id: string;
  createdAt: string;
  paidAt: string | null;
  status: OrderStatus;
  badge: { label: string; tone: BadgeTone };
  items: AccountOrderItem[];
  /** "Medical · Annual ×2, Restaurant · Monthly" (prototype ITEMS cell). */
  summary: string;
  /** Name of the member who placed it, or null for a guest checkout. */
  placedByName: string | null;
  /** "by Priya Sharma" or "Guest checkout". */
  placedByLabel: string;
  invoiceNumber: string | null;
  invoiceIssuedAt: string | null;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** cgst + sgst + igst ("incl. ₹x GST"). */
  taxPaise: number;
  totalPaise: number;
  /** The order page (a full page load: it carries its own CSP; decisions.md Phase 3 integration). */
  href: string;
  /** The tax invoice PDF, once an invoice exists. */
  invoicePdfHref: string | null;
};

export type AccountOrderList = {
  orders: AccountOrderRow[];
  /** Orders matching the filters (all pages). */
  total: number;
  /** The page shown (pages past the end show the last page). */
  page: number;
  pageSize: number;
  pageCount: number;
};

const ORDER_SELECT = {
  id: true,
  status: true,
  createdAt: true,
  paidAt: true,
  taxablePaise: true,
  cgstPaise: true,
  sgstPaise: true,
  igstPaise: true,
  totalPaise: true,
  placeOfSupply: true,
  billing: true,
  placedBy: { select: { name: true, email: true } },
  invoice: { select: { number: true, issuedAt: true, seller: true } },
  items: {
    orderBy: { id: "asc" },
    select: {
      kind: true,
      quantity: true,
      plan: { select: { name: true, product: { select: { id: true, shortName: true } } } },
    },
  },
} as const satisfies Prisma.OrderSelect;

type OrderRecord = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

/** Account scope + filters as one Prisma where (the account id always comes from the server-side session). */
export function accountOrdersWhere(accountId: string, query: Pick<OrderListQuery, "q" | "status">): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = { accountId };
  if (query.status !== "all") where.status = { in: [...ORDER_STATUS_FILTER_STATUSES[query.status]] };
  if (query.q !== "") {
    where.OR = [
      { id: { contains: query.q, mode: "insensitive" } },
      { invoice: { is: { number: { contains: query.q, mode: "insensitive" } } } },
    ];
  }
  return where;
}

export function accountOrdersOrderBy(sort: OrderListQuery["sort"]): Prisma.OrderOrderByWithRelationInput[] {
  const dir = sort.dir === 1 ? "asc" : "desc";
  switch (sort.key) {
    case "date":
      return [{ createdAt: dir }, { id: dir }];
    case "total":
      return [{ totalPaise: dir }, { createdAt: "desc" }, { id: "desc" }];
    case "status":
      return [{ status: dir }, { createdAt: "desc" }, { id: "desc" }];
  }
}

export function orderItemsSummary(items: readonly Pick<AccountOrderItem, "productShortName" | "planName" | "qty">[]): string {
  return items.map((i) => `${i.productShortName} \u00b7 ${i.planName}${i.qty > 1 ? ` \u00d7${i.qty}` : ""}`).join(", ");
}

export function placedByLabel(placedBy: { name: string } | null): string {
  if (!placedBy) return GUEST_CHECKOUT_LABEL;
  const name = placedBy.name.trim();
  return name ? `by ${name}` : "by account";
}

function toOrderRow(o: OrderRecord): AccountOrderRow {
  const items = o.items.map((i) => ({
    productId: i.plan.product.id,
    productShortName: i.plan.product.shortName,
    planName: i.plan.name,
    qty: i.quantity,
    kind: i.kind,
  }));
  return {
    id: o.id,
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt ? o.paidAt.toISOString() : null,
    status: o.status,
    badge: ORDER_STATUS_BADGES[o.status],
    items,
    summary: orderItemsSummary(items),
    placedByName: o.placedBy ? o.placedBy.name.trim() || null : null,
    placedByLabel: placedByLabel(o.placedBy),
    invoiceNumber: o.invoice?.number ?? null,
    invoiceIssuedAt: o.invoice ? o.invoice.issuedAt.toISOString() : null,
    taxablePaise: o.taxablePaise,
    cgstPaise: o.cgstPaise,
    sgstPaise: o.sgstPaise,
    igstPaise: o.igstPaise,
    taxPaise: o.cgstPaise + o.sgstPaise + o.igstPaise,
    totalPaise: o.totalPaise,
    href: `/orders/${encodeURIComponent(o.id)}`,
    invoicePdfHref: o.invoice ? `/api/orders/${encodeURIComponent(o.id)}/invoice.pdf` : null,
  };
}

/** GET /api/account/orders: one page of the account's orders. */
export async function listAccountOrders(client: Db, accountId: string, query: OrderListQuery): Promise<AccountOrderList> {
  const where = accountOrdersWhere(accountId, query);
  const total = await client.order.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));
  const page = Math.min(query.page, pageCount);
  const records = await client.order.findMany({
    where,
    orderBy: accountOrdersOrderBy(query.sort),
    skip: (page - 1) * ORDERS_PAGE_SIZE,
    take: ORDERS_PAGE_SIZE,
    select: ORDER_SELECT,
  });
  return { orders: records.map(toOrderRow), total, page, pageSize: ORDERS_PAGE_SIZE, pageCount };
}

// ---------- Accountant CSV ----------

/** "2026-10-07": the IST calendar date (spreadsheets parse ISO dates). */
export function istIsoDate(d: Date | null | undefined): string {
  if (!d) return "";
  const p = istParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function sellerGstin(seller: unknown): string {
  if (seller === null || typeof seller !== "object" || Array.isArray(seller)) return "";
  const gstin = (seller as Record<string, unknown>).gstin;
  return typeof gstin === "string" ? gstin : "";
}

/**
 * Columns of orders.csv: the prototype's nine (Order, Date, Invoice, Status, Taxable, CGST, SGST, IGST, Total), then
 * the invoice date, place of supply and both GSTINs an accountant needs to match the invoice.
 */
export const ORDER_CSV_COLUMNS: readonly CsvColumn<OrderRecord>[] = [
  { header: "Order", value: (o) => o.id },
  { header: "Date", value: (o) => istIsoDate(o.createdAt) },
  { header: "Invoice", value: (o) => o.invoice?.number ?? "" },
  { header: "Status", value: (o) => ORDER_STATUS_BADGES[o.status].label },
  { header: "Taxable", value: (o) => paiseToDecimalString(o.taxablePaise) },
  { header: "CGST", value: (o) => paiseToDecimalString(o.cgstPaise) },
  { header: "SGST", value: (o) => paiseToDecimalString(o.sgstPaise) },
  { header: "IGST", value: (o) => paiseToDecimalString(o.igstPaise) },
  { header: "Total", value: (o) => paiseToDecimalString(o.totalPaise) },
  { header: "Invoice date", value: (o) => istIsoDate(o.invoice?.issuedAt) },
  { header: "Place of supply", value: (o) => o.placeOfSupply },
  { header: "Billed GSTIN", value: (o) => readBillingSnapshot(o.billing).gstin ?? "" },
  { header: "Seller GSTIN", value: (o) => sellerGstin(o.invoice?.seller) },
];

/** Note row appended when the export hit ORDERS_EXPORT_LIMIT (new copy). */
export function ordersExportCutNote(limit: number = ORDERS_EXPORT_LIMIT): string {
  return `Only the first ${limit.toLocaleString("en-IN")} orders were exported. Narrow the filters to export the rest.`;
}

/**
 * GET /api/account/orders/export.csv: every order matching the filters (no paging), in the list's sort order, as a
 * UTF-8 CSV with BOM and CRLF line endings (lib/csv: quoted cells, formula-injection guard).
 */
export async function exportAccountOrdersCsv(
  client: Db,
  accountId: string,
  query: Pick<OrderListQuery, "q" | "status" | "sort">,
  limit: number = ORDERS_EXPORT_LIMIT,
): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const records = await client.order.findMany({
    where: accountOrdersWhere(accountId, query),
    orderBy: accountOrdersOrderBy(query.sort),
    take: limit + 1,
    select: ORDER_SELECT,
  });
  const listed = records.slice(0, limit);
  const lines: string[] = [csvRow(ORDER_CSV_COLUMNS.map((c) => c.header))];
  for (const o of listed) lines.push(csvRow(ORDER_CSV_COLUMNS.map((c): CsvValue => c.value(o))));
  const truncated = records.length > limit;
  if (truncated) lines.push(csvRow([ordersExportCutNote(limit)]));
  return { csv: `${CSV_BOM}${lines.join(CSV_EOL)}${CSV_EOL}`, rows: listed.length, truncated };
}
