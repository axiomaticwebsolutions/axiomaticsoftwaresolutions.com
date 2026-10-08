/**
 * Admin order list, stats, filter options and CSV export rows (server). The page renders the list for its URL state
 * and GET /api/admin/orders answers the same query: { items, total, page, pageSize }.
 */
import "server-only";
import { OrderStatus, RefundStatus, type Prisma } from "@/generated/prisma/client";
import { ADMIN_EXPORT_MAX_ROWS } from "@/lib/admin/export";
import { parseListQuery } from "@/lib/admin/list-query";
import type { CsvColumn } from "@/lib/csv";
import type { Db } from "@/lib/db";
import { formatDateTimeIST } from "@/lib/dates";
import { isProduction } from "@/lib/env";
import { paiseToDecimalString } from "@/lib/money";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { OFFLINE_PROVIDER, PAYMENT_PROVIDER_KEYS } from "@/lib/payments/types";
import { orderOrderBy, orderWhere } from "./filters";
import {
  ADMIN_ORDERS_BULK_MAX,
  ADMIN_ORDERS_PAGE_SIZE,
  ADMIN_ORDERS_SEARCH_MAX,
  itemLabel,
  ORDER_DATE_FILTERS,
  ORDER_METHOD_FILTERS,
  ORDER_PROVIDER_FILTERS,
  ORDER_SORTS,
  ORDER_STATUS_FILTER_LABELS,
  ORDER_STATUS_FILTERS,
  parseCouponFilter,
  parseDayFilter,
  parseProductFilter,
  taxLabel,
  type AdminOrderFilterOptions,
  type AdminOrderList,
  type AdminOrderQuery,
  type AdminOrderRow,
  type AdminOrderStats,
  type OrderStatusValue,
} from "./model";

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;

/** `ids=AX-1,AX-2` (export selected): at most ADMIN_ORDERS_BULK_MAX well-formed ids, or undefined. */
export function parseIdsParam(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => ID_SHAPE.test(s)))];
  return ids.length > 0 ? ids.slice(0, ADMIN_ORDERS_BULK_MAX) : undefined;
}

/** The API's list query (lenient: unknown values fall back to defaults; pageSize at most 100). */
export function orderQueryFromRequest(input: Request | URL): AdminOrderQuery {
  const parsed = parseListQuery(input, {
    filters: {
      status: ORDER_STATUS_FILTERS,
      method: ORDER_METHOD_FILTERS,
      product: parseProductFilter,
      date: ORDER_DATE_FILTERS,
      from: parseDayFilter,
      to: parseDayFilter,
      coupon: parseCouponFilter,
      provider: ORDER_PROVIDER_FILTERS,
    },
    sortable: ORDER_SORTS,
    defaultSort: { id: "createdAt", desc: true },
    defaultPageSize: ADMIN_ORDERS_PAGE_SIZE,
    maxQueryLength: ADMIN_ORDERS_SEARCH_MAX,
  });
  const url = input instanceof URL ? input : new URL(input.url);
  const ids = parseIdsParam(url.searchParams.get("ids"));
  return {
    q: parsed.q,
    filters: { ...parsed.filters, ...(ids ? { ids } : {}) },
    sort: parsed.sort,
    page: parsed.page,
    pageSize: parsed.pageSize,
  };
}

const rowSelect = {
  id: true,
  createdAt: true,
  email: true,
  billing: true,
  status: true,
  couponCode: true,
  totalPaise: true,
  cgstPaise: true,
  sgstPaise: true,
  igstPaise: true,
  account: { select: { legalName: true } },
  invoice: { select: { number: true } },
  items: {
    select: { quantity: true, plan: { select: { name: true, product: { select: { name: true, shortName: true } } } } },
    orderBy: { id: "asc" },
  },
  payments: {
    select: { method: true, provider: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
  },
} satisfies Prisma.OrderSelect;

type RowRecord = Prisma.OrderGetPayload<{ select: typeof rowSelect }>;

export function statusValue(status: OrderStatus): OrderStatusValue {
  return status.toLowerCase() as OrderStatusValue;
}

/** The console's product label: the short name ("Medical Store Billing"), else the full name. */
export function productLabel(product: { name: string; shortName: string }): string {
  return product.shortName.trim() || product.name;
}

/** Business, else account name, else billing name, else the email. */
export function customerName(billingJson: unknown, accountName: string | null | undefined, email: string): string {
  const billing = readBillingSnapshot(billingJson);
  return billing.business?.trim() || accountName?.trim() || billing.name.trim() || email;
}

function toRow(o: RowRecord): AdminOrderRow {
  const latest = o.payments[0];
  return {
    id: o.id,
    createdAt: o.createdAt.toISOString(),
    invoiceNumber: o.invoice?.number ?? null,
    customer: customerName(o.billing, o.account?.legalName, o.email),
    email: o.email,
    items: o.items.map((i) => itemLabel(productLabel(i.plan.product), i.plan.name, i.quantity)).join(", "),
    status: statusValue(o.status),
    method: latest?.method ?? null,
    provider: latest?.provider ?? null,
    couponCode: o.couponCode,
    totalPaise: o.totalPaise,
    taxLabel: taxLabel(o),
  };
}

/** One page of orders for `query`. */
export async function listAdminOrders(db: Db, query: AdminOrderQuery, now: Date = new Date()): Promise<AdminOrderList> {
  const where = orderWhere(query.q, query.filters, now);
  const [total, records] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({
      where,
      orderBy: orderOrderBy(query.sort),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: rowSelect,
    }),
  ]);
  return { items: records.map(toRow), total, page: query.page, pageSize: query.pageSize };
}

/** Stats row (all time): paid (incl. partly refunded), payments in flight, failed, and the money refunded. */
export async function adminOrderStats(db: Db): Promise<AdminOrderStats> {
  const [groups, refunds] = await Promise.all([
    db.order.groupBy({ by: ["status"], _count: { _all: true } }),
    db.refund.aggregate({ where: { status: { not: RefundStatus.FAILED } }, _sum: { amountPaise: true } }),
  ]);
  const count = (...statuses: OrderStatus[]) =>
    groups.filter((g) => statuses.includes(g.status)).reduce((sum, g) => sum + g._count._all, 0);
  return {
    paid: count(OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED),
    pending: count(OrderStatus.PENDING, OrderStatus.CONFIRMING),
    failed: count(OrderStatus.FAILED),
    refundedPaise: refunds._sum.amountPaise ?? 0,
  };
}

/**
 * Options of the Product, Coupon and Provider selects: products by short name in catalog rank order (as the Plans and
 * Releases filters). The mock provider is listed outside production only; "Offline" (payments staff recorded) always.
 */
export async function adminOrderFilterOptions(db: Db): Promise<AdminOrderFilterOptions> {
  const [products, coupons] = await Promise.all([
    db.product.findMany({ select: { id: true, name: true, shortName: true }, orderBy: [{ rank: "asc" }, { name: "asc" }, { id: "asc" }], take: 200 }),
    db.coupon.findMany({ select: { code: true }, orderBy: { code: "asc" }, take: 200 }),
  ]);
  return {
    products: products.map((p) => ({ value: p.id, label: productLabel(p) })),
    coupons: coupons.map((c) => c.code),
    providers: [...PAYMENT_PROVIDER_KEYS.filter((k) => k !== "mock" || !isProduction()), OFFLINE_PROVIDER],
  };
}

// ---------- CSV export ----------

export type OrderExportRow = AdminOrderRow & {
  gstin: string | null;
  placeOfSupply: string;
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  paidAt: Date | null;
  createdAtDate: Date;
};

/** Up to maxRows + 1 rows (the extra one marks truncation) for the list query, in list order. */
export async function exportAdminOrders(
  db: Db,
  query: AdminOrderQuery,
  now: Date = new Date(),
  maxRows: number = ADMIN_EXPORT_MAX_ROWS,
): Promise<OrderExportRow[]> {
  const records = await db.order.findMany({
    where: orderWhere(query.q, query.filters, now),
    orderBy: orderOrderBy(query.sort),
    take: maxRows + 1,
    select: { ...rowSelect, placeOfSupply: true, subtotalPaise: true, discountPaise: true, taxablePaise: true, paidAt: true },
  });
  return records.map((r) => ({
    ...toRow(r),
    gstin: readBillingSnapshot(r.billing).gstin,
    placeOfSupply: r.placeOfSupply,
    subtotalPaise: r.subtotalPaise,
    discountPaise: r.discountPaise,
    taxablePaise: r.taxablePaise,
    cgstPaise: r.cgstPaise,
    sgstPaise: r.sgstPaise,
    igstPaise: r.igstPaise,
    paidAt: r.paidAt,
    createdAtDate: r.createdAt,
  }));
}

const rupees = (paise: number) => paiseToDecimalString(paise);

/** Accountant-friendly columns (IST dates, rupees without symbols, GST split). Never payment instrument data. */
export const ORDER_EXPORT_COLUMNS: readonly CsvColumn<OrderExportRow>[] = [
  { header: "Order", value: (r) => r.id },
  { header: "Date (IST)", value: (r) => formatDateTimeIST(r.createdAtDate) },
  { header: "Invoice", value: (r) => r.invoiceNumber ?? "" },
  { header: "Customer", value: (r) => r.customer },
  { header: "Email", value: (r) => r.email },
  { header: "GSTIN", value: (r) => r.gstin ?? "" },
  { header: "Place of supply", value: (r) => r.placeOfSupply },
  { header: "Items", value: (r) => r.items },
  { header: "Status", value: (r) => ORDER_STATUS_FILTER_LABELS[r.status] },
  { header: "Method", value: (r) => r.method ?? "" },
  { header: "Provider", value: (r) => r.provider ?? "" },
  { header: "Coupon", value: (r) => r.couponCode ?? "" },
  { header: "Subtotal", value: (r) => rupees(r.subtotalPaise) },
  { header: "Discount", value: (r) => rupees(r.discountPaise) },
  { header: "Taxable", value: (r) => rupees(r.taxablePaise) },
  { header: "CGST", value: (r) => rupees(r.cgstPaise) },
  { header: "SGST", value: (r) => rupees(r.sgstPaise) },
  { header: "IGST", value: (r) => rupees(r.igstPaise) },
  { header: "GST", value: (r) => rupees(r.cgstPaise + r.sgstPaise + r.igstPaise) },
  { header: "Total", value: (r) => rupees(r.totalPaise) },
  { header: "Paid at (IST)", value: (r) => (r.paidAt ? formatDateTimeIST(r.paidAt) : "") },
];

/** "status: paid · last 30 days · search" for the export's audit row (never the search text: it may hold an email). */
export function exportAuditDetail(query: AdminOrderQuery): string | null {
  const f = query.filters;
  const parts: string[] = [];
  if (f.ids) parts.push(`${f.ids.length} selected`);
  if (f.status) parts.push(`status: ${f.status}`);
  if (f.method) parts.push(`method: ${f.method}`);
  if (f.product) parts.push(`product: ${f.product}`);
  if (f.provider) parts.push(`provider: ${f.provider}`);
  if (f.coupon) parts.push(`coupon: ${f.coupon}`);
  if (f.date) parts.push(`date: ${f.date}`);
  if (f.from || f.to) parts.push(`dates: ${f.from ?? "…"} to ${f.to ?? "…"}`);
  if (query.q) parts.push("filtered by search");
  return parts.length > 0 ? parts.join(" \u00B7 ") : null;
}
