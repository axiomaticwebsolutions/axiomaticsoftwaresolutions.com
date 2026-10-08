/**
 * Aggregate queries behind the admin Overview and Reports (server-only). Everything is summed in the database, so a
 * year of orders or 25 lakh licenses never reach the app: grouped SQL by IST day or month (timestamps are stored as
 * UTC `timestamp(3)`, so "+ 330 minutes" gives the IST calendar date; India has no DST), Prisma groupBy/count for
 * statuses. Only the rare rows that need splitting in code (partly refunded orders, credit notes) are read one by one,
 * with a cap.
 *
 * Billing corrections (Admin > Orders, InvoiceCorrection): the Invoice row holds the order's CURRENT invoice, renumbered
 * by each correction. So every invoice ever issued is counted once, in the month it was issued: current invoices by
 * Invoice.issuedAt, plus each cancelled original by InvoiceCorrection.originalIssuedAt (with its amounts). Every
 * correction's credit note counts in the month it was issued, so the correction month nets to zero and the original
 * month is unchanged.
 */
import "server-only";
import { LicenseStatus, OrderStatus, RefundStatus, TicketStatus } from "@/generated/prisma/client";
import { FIRST_RESPONSE_AT_SQL } from "@/lib/admin/tickets/first-response";
import { DAY_MS } from "@/lib/dates";
import type { Db } from "@/lib/db";
import { EXPIRING_DAYS, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { emptyHealthCounts, refundSplit, splitOverLines, type LicenseHealthCounts, type TaxSplit } from "./model";

/** Rows read one by one for code-side splitting (partly refunded orders, credit notes) per query. */
export const SPLIT_ROWS_LIMIT = 5000;

/** Numbers from raw SQL (bigint sums arrive as BigInt or strings, counts as numbers). */
export function sqlNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return 0;
}

export type Window = { from: Date; to: Date };

// ---------- Paid revenue (Overview: orders by paidAt, net of partial refunds) ----------

export type RevenueDayRow = { day: string; orders: number; taxablePaise: number };

/** PAID and PARTLY REFUNDED orders per IST day of `paidAt` (gross taxable). */
export async function paidRevenueByDay(client: Db, w: Window): Promise<RevenueDayRow[]> {
  const rows = await client.$queryRaw<Array<{ day: string; orders: number; taxable: unknown }>>`
    SELECT to_char(o."paidAt" + interval '330 minutes', 'YYYY-MM-DD') AS "day",
           count(*)::int AS "orders",
           coalesce(sum(o."taxablePaise"), 0)::bigint AS "taxable"
    FROM "Order" o
    WHERE o."status" IN ('PAID'::"OrderStatus", 'PARTIALLY_REFUNDED'::"OrderStatus")
      AND o."paidAt" >= ${w.from}::timestamp(3) AND o."paidAt" < ${w.to}::timestamp(3)
    GROUP BY 1`;
  return rows.map((r) => ({ day: r.day, orders: sqlNumber(r.orders), taxablePaise: sqlNumber(r.taxable) }));
}

/** Paid orders and gross taxable value in a window (the previous period of the REVENUE card). */
export async function paidRevenueTotal(client: Db, w: Window): Promise<{ orders: number; taxablePaise: number }> {
  const agg = await client.order.aggregate({
    where: { status: { in: [OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED] }, paidAt: { gte: w.from, lt: w.to } },
    _count: { _all: true },
    _sum: { taxablePaise: true },
  });
  return { orders: agg._count._all, taxablePaise: agg._sum.taxablePaise ?? 0 };
}

export type PartialRefundAdjustment = {
  orderId: string;
  paidAt: Date;
  /** Taxable value refunded (processed refunds only). */
  taxablePaise: number;
  /** The same per product (by line taxable share). */
  byProduct: Map<string, number>;
};

/** Processed refunds of partly refunded orders paid in the window, as taxable reductions (portal spend rule). */
export async function partialRefundAdjustments(client: Db, w: Window): Promise<PartialRefundAdjustment[]> {
  const orders = await client.order.findMany({
    where: { status: OrderStatus.PARTIALLY_REFUNDED, paidAt: { gte: w.from, lt: w.to } },
    orderBy: { paidAt: "asc" },
    take: SPLIT_ROWS_LIMIT,
    select: {
      id: true,
      paidAt: true,
      taxablePaise: true,
      cgstPaise: true,
      sgstPaise: true,
      igstPaise: true,
      totalPaise: true,
      items: { select: { taxablePaise: true, plan: { select: { productId: true } } }, orderBy: { id: "asc" } },
      payments: { select: { refunds: { where: { status: RefundStatus.PROCESSED }, select: { amountPaise: true } } } },
    },
  });
  return orders.flatMap((o) => {
    const refunded = o.payments.reduce((s, p) => s + p.refunds.reduce((r, x) => r + x.amountPaise, 0), 0);
    if (refunded <= 0 || !o.paidAt) return [];
    const taxable = refundSplit(refunded, o).taxablePaise;
    const shares = splitOverLines(taxable, o.items.map((i) => i.taxablePaise));
    const byProduct = new Map<string, number>();
    o.items.forEach((item, i) => byProduct.set(item.plan.productId, (byProduct.get(item.plan.productId) ?? 0) + (shares[i] ?? 0)));
    return [{ orderId: o.id, paidAt: o.paidAt, taxablePaise: taxable, byProduct }];
  });
}

/** Per product: paid orders containing it and its line taxable value (gross) in the window. */
export async function paidSalesByProduct(client: Db, w: Window): Promise<Map<string, { orders: number; taxablePaise: number }>> {
  const rows = await client.$queryRaw<Array<{ productId: string; orders: number; taxable: unknown }>>`
    SELECT pl."productId" AS "productId", count(DISTINCT o."id")::int AS "orders",
           coalesce(sum(oi."taxablePaise"), 0)::bigint AS "taxable"
    FROM "Order" o
    JOIN "OrderItem" oi ON oi."orderId" = o."id"
    JOIN "Plan" pl ON pl."id" = oi."planId"
    WHERE o."status" IN ('PAID'::"OrderStatus", 'PARTIALLY_REFUNDED'::"OrderStatus")
      AND o."paidAt" >= ${w.from}::timestamp(3) AND o."paidAt" < ${w.to}::timestamp(3)
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.productId, { orders: sqlNumber(r.orders), taxablePaise: sqlNumber(r.taxable) }]));
}

// ---------- Tax invoices and credit notes (Reports) ----------

export type InvoiceAggRow = { key: string; count: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number };

/**
 * Tax invoices issued in the window per IST month ("YYYY-MM"), with the tax split: current invoices by
 * Invoice.issuedAt, plus invoices a billing correction cancelled, by their original issue date.
 */
export async function invoicesByMonth(client: Db, w: Window): Promise<InvoiceAggRow[]> {
  const rows = await client.$queryRaw<Array<{ key: string; count: number; taxable: unknown; cgst: unknown; sgst: unknown; igst: unknown }>>`
    SELECT to_char(d."at" + interval '330 minutes', 'YYYY-MM') AS "key", count(*)::int AS "count",
           coalesce(sum(d."taxable"), 0)::bigint AS "taxable", coalesce(sum(d."cgst"), 0)::bigint AS "cgst",
           coalesce(sum(d."sgst"), 0)::bigint AS "sgst", coalesce(sum(d."igst"), 0)::bigint AS "igst"
    FROM (
      SELECT i."issuedAt" AS "at", o."taxablePaise" AS "taxable", o."cgstPaise" AS "cgst", o."sgstPaise" AS "sgst", o."igstPaise" AS "igst"
      FROM "Invoice" i
      JOIN "Order" o ON o."id" = i."orderId"
      WHERE i."issuedAt" >= ${w.from}::timestamp(3) AND i."issuedAt" < ${w.to}::timestamp(3)
      UNION ALL
      SELECT c."originalIssuedAt", c."taxablePaise", c."cgstPaise", c."sgstPaise", c."igstPaise"
      FROM "InvoiceCorrection" c
      WHERE c."originalIssuedAt" >= ${w.from}::timestamp(3) AND c."originalIssuedAt" < ${w.to}::timestamp(3)
    ) d
    GROUP BY 1`;
  return rows.map(toInvoiceAgg);
}

/** Tax invoices issued in the window per place of supply (state), cancelled originals included (as invoicesByMonth). */
export async function invoicesByState(client: Db, w: Window): Promise<InvoiceAggRow[]> {
  const rows = await client.$queryRaw<Array<{ key: string; count: number; taxable: unknown; cgst: unknown; sgst: unknown; igst: unknown }>>`
    SELECT d."state" AS "key", count(*)::int AS "count",
           coalesce(sum(d."taxable"), 0)::bigint AS "taxable", coalesce(sum(d."cgst"), 0)::bigint AS "cgst",
           coalesce(sum(d."sgst"), 0)::bigint AS "sgst", coalesce(sum(d."igst"), 0)::bigint AS "igst"
    FROM (
      SELECT o."placeOfSupply" AS "state", o."taxablePaise" AS "taxable", o."cgstPaise" AS "cgst", o."sgstPaise" AS "sgst", o."igstPaise" AS "igst"
      FROM "Invoice" i
      JOIN "Order" o ON o."id" = i."orderId"
      WHERE i."issuedAt" >= ${w.from}::timestamp(3) AND i."issuedAt" < ${w.to}::timestamp(3)
      UNION ALL
      SELECT o."placeOfSupply", c."taxablePaise", c."cgstPaise", c."sgstPaise", c."igstPaise"
      FROM "InvoiceCorrection" c
      JOIN "Order" o ON o."id" = c."orderId"
      WHERE c."originalIssuedAt" >= ${w.from}::timestamp(3) AND c."originalIssuedAt" < ${w.to}::timestamp(3)
    ) d
    GROUP BY 1
    ORDER BY 1`;
  return rows.map(toInvoiceAgg);
}

/** Invoices a billing correction cancelled whose original issue date is in the window (salesByProduct's count). */
export async function cancelledInvoicesInWindow(client: Db, w: Window): Promise<number> {
  return client.invoiceCorrection.count({ where: { originalIssuedAt: { gte: w.from, lt: w.to } } });
}

function toInvoiceAgg(r: { key: string; count: number; taxable: unknown; cgst: unknown; sgst: unknown; igst: unknown }): InvoiceAggRow {
  return {
    key: r.key,
    count: sqlNumber(r.count),
    taxablePaise: sqlNumber(r.taxable),
    cgstPaise: sqlNumber(r.cgst),
    sgstPaise: sqlNumber(r.sgst),
    igstPaise: sqlNumber(r.igst),
  };
}

/**
 * Per product: invoices containing it (distinct document numbers, so a corrected order counts its original and its new
 * invoice) and its line taxable value (gross), for invoices issued in the window, cancelled originals included.
 */
export async function invoicedSalesByProduct(client: Db, w: Window): Promise<Map<string, { orders: number; taxablePaise: number }>> {
  const rows = await client.$queryRaw<Array<{ productId: string; orders: number; taxable: unknown }>>`
    SELECT pl."productId" AS "productId", count(DISTINCT d."docNo")::int AS "orders",
           coalesce(sum(oi."taxablePaise"), 0)::bigint AS "taxable"
    FROM (
      SELECT i."number" AS "docNo", i."orderId" AS "orderId"
      FROM "Invoice" i
      WHERE i."issuedAt" >= ${w.from}::timestamp(3) AND i."issuedAt" < ${w.to}::timestamp(3)
      UNION ALL
      SELECT c."originalInvoiceNo", c."orderId"
      FROM "InvoiceCorrection" c
      WHERE c."originalIssuedAt" >= ${w.from}::timestamp(3) AND c."originalIssuedAt" < ${w.to}::timestamp(3)
    ) d
    JOIN "OrderItem" oi ON oi."orderId" = d."orderId"
    JOIN "Plan" pl ON pl."id" = oi."planId"
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.productId, { orders: sqlNumber(r.orders), taxablePaise: sqlNumber(r.taxable) }]));
}

export type CreditNoteRow = {
  id: string;
  /** "refund" (Refund.creditNoteNo) or "correction" (a billing correction's credit note, always PROCESSED). */
  kind: "refund" | "correction";
  number: string;
  status: RefundStatus;
  issuedAt: Date;
  processedAt: Date | null;
  amountPaise: number;
  split: TaxSplit;
  /** Taxable value per product (by the order's line shares). */
  byProduct: Map<string, number>;
  order: { id: string; email: string; billing: unknown; placeOfSupply: string; invoiceNumber: string | null };
};

/**
 * Credit notes issued in the window, oldest first, at most `take`: refunds with a number (not FAILED), and the credit
 * notes of billing corrections (the full value of the invoice they cancel, split from the correction's own columns).
 */
export async function creditNotesInWindow(client: Db, w: Window, take: number = SPLIT_ROWS_LIMIT): Promise<CreditNoteRow[]> {
  const [refundNotes, corrections] = await Promise.all([refundCreditNotes(client, w, take), correctionCreditNotes(client, w, take)]);
  return [...refundNotes, ...corrections]
    .sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime() || a.number.localeCompare(b.number))
    .slice(0, take);
}

async function correctionCreditNotes(client: Db, w: Window, take: number): Promise<CreditNoteRow[]> {
  const rows = await client.invoiceCorrection.findMany({
    where: { issuedAt: { gte: w.from, lt: w.to } },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    take,
    select: {
      id: true,
      creditNoteNo: true,
      issuedAt: true,
      originalInvoiceNo: true,
      originalBilling: true,
      taxablePaise: true,
      cgstPaise: true,
      sgstPaise: true,
      igstPaise: true,
      totalPaise: true,
      order: {
        select: {
          id: true,
          email: true,
          placeOfSupply: true,
          items: { select: { taxablePaise: true, plan: { select: { productId: true } } }, orderBy: { id: "asc" } },
        },
      },
    },
  });
  return rows.map((c) => {
    const split: TaxSplit = { taxablePaise: c.taxablePaise, cgstPaise: c.cgstPaise, sgstPaise: c.sgstPaise, igstPaise: c.igstPaise };
    const shares = splitOverLines(split.taxablePaise, c.order.items.map((i) => i.taxablePaise));
    const byProduct = new Map<string, number>();
    c.order.items.forEach((item, i) => byProduct.set(item.plan.productId, (byProduct.get(item.plan.productId) ?? 0) + (shares[i] ?? 0)));
    return {
      id: c.id,
      kind: "correction" as const,
      number: c.creditNoteNo,
      status: RefundStatus.PROCESSED,
      issuedAt: c.issuedAt,
      processedAt: c.issuedAt,
      amountPaise: c.totalPaise,
      split,
      byProduct,
      order: { id: c.order.id, email: c.order.email, billing: c.originalBilling, placeOfSupply: c.order.placeOfSupply, invoiceNumber: c.originalInvoiceNo },
    };
  });
}

async function refundCreditNotes(client: Db, w: Window, take: number): Promise<CreditNoteRow[]> {
  const refunds = await client.refund.findMany({
    where: { creditNoteNo: { not: null }, status: { not: RefundStatus.FAILED }, createdAt: { gte: w.from, lt: w.to } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
    select: {
      id: true,
      creditNoteNo: true,
      status: true,
      createdAt: true,
      processedAt: true,
      amountPaise: true,
      payment: {
        select: {
          order: {
            select: {
              id: true,
              email: true,
              billing: true,
              placeOfSupply: true,
              taxablePaise: true,
              cgstPaise: true,
              sgstPaise: true,
              igstPaise: true,
              totalPaise: true,
              invoice: { select: { number: true } },
              items: { select: { taxablePaise: true, plan: { select: { productId: true } } }, orderBy: { id: "asc" } },
            },
          },
        },
      },
    },
  });
  return refunds.map((r) => {
    const o = r.payment.order;
    const split = refundSplit(r.amountPaise, o);
    const shares = splitOverLines(split.taxablePaise, o.items.map((i) => i.taxablePaise));
    const byProduct = new Map<string, number>();
    o.items.forEach((item, i) => byProduct.set(item.plan.productId, (byProduct.get(item.plan.productId) ?? 0) + (shares[i] ?? 0)));
    return {
      id: r.id,
      kind: "refund" as const,
      number: r.creditNoteNo ?? "",
      status: r.status,
      issuedAt: r.createdAt,
      processedAt: r.processedAt,
      amountPaise: r.amountPaise,
      split,
      byProduct,
      order: { id: o.id, email: o.email, billing: o.billing, placeOfSupply: o.placeOfSupply, invoiceNumber: o.invoice?.number ?? null },
    };
  });
}

// ---------- License health (derived statuses, lib/licensing/status.ts) ----------

export type LicenseHealthResult = { totals: LicenseHealthCounts; byProduct: Map<string, LicenseHealthCounts> };

/**
 * Derived status counts per product at `now`, from four grouped counts on License(status, expiresAt): stored status,
 * then the ACTIVE licenses that ended or end within EXPIRING_DAYS and the TRIAL licenses that ended. Same precedence
 * as deriveLicenseStatus(): revoked, suspended, expired, trial, expiring, active.
 */
export async function licenseHealthCounts(client: Db, now: Date): Promise<LicenseHealthResult> {
  const expiringBefore = new Date(now.getTime() + EXPIRING_DAYS * DAY_MS);
  const [byStatus, activeEnded, activeEnding, trialEnded] = await Promise.all([
    client.license.groupBy({ by: ["productId", "status"], _count: { _all: true } }),
    client.license.groupBy({ by: ["productId"], where: { status: LicenseStatus.ACTIVE, expiresAt: { lte: now } }, _count: { _all: true } }),
    client.license.groupBy({
      by: ["productId"],
      where: { status: LicenseStatus.ACTIVE, expiresAt: { gt: now, lt: expiringBefore } },
      _count: { _all: true },
    }),
    client.license.groupBy({ by: ["productId"], where: { status: LicenseStatus.TRIAL, expiresAt: { lte: now } }, _count: { _all: true } }),
  ]);
  const byProduct = new Map<string, LicenseHealthCounts>();
  const of = (productId: string) => {
    let counts = byProduct.get(productId);
    if (!counts) byProduct.set(productId, (counts = emptyHealthCounts()));
    return counts;
  };
  const add = (productId: string, key: DerivedLicenseStatus, n: number) => {
    of(productId)[key] += n;
  };
  for (const row of byStatus) {
    const n = row._count._all;
    if (row.status === LicenseStatus.REVOKED) add(row.productId, "revoked", n);
    else if (row.status === LicenseStatus.SUSPENDED) add(row.productId, "suspended", n);
    else if (row.status === LicenseStatus.TRIAL) add(row.productId, "trial", n);
    else add(row.productId, "active", n);
  }
  for (const row of activeEnded) {
    add(row.productId, "active", -row._count._all);
    add(row.productId, "expired", row._count._all);
  }
  for (const row of activeEnding) {
    add(row.productId, "active", -row._count._all);
    add(row.productId, "expiring", row._count._all);
  }
  for (const row of trialEnded) {
    add(row.productId, "trial", -row._count._all);
    add(row.productId, "expired", row._count._all);
  }
  const totals = emptyHealthCounts();
  for (const counts of byProduct.values()) {
    for (const key of Object.keys(totals) as DerivedLicenseStatus[]) totals[key] += counts[key];
  }
  return { totals, byProduct };
}

/** ACTIVE licenses whose end date falls within the next `days` days (the ACTIVE LICENSES card). */
export async function licensesEndingWithin(client: Db, now: Date, days: number): Promise<number> {
  return client.license.count({
    where: { status: LicenseStatus.ACTIVE, expiresAt: { gt: now, lte: new Date(now.getTime() + days * DAY_MS) } },
  });
}

// ---------- Support ----------

export const OPEN_TICKET_STATUSES = [TicketStatus.OPEN, TicketStatus.AWAITING_CUSTOMER] as const;

export type OpenTicketGroup = { status: TicketStatus; high: boolean; assigneeId: string | null; count: number };

/** Open tickets (waiting on us or on the customer) grouped by status, high priority and assignee. */
export async function openTicketGroups(client: Db): Promise<OpenTicketGroup[]> {
  const rows = await client.supportTicket.groupBy({
    by: ["status", "priority", "assigneeId"],
    where: { status: { in: [...OPEN_TICKET_STATUSES] } },
    _count: { _all: true },
  });
  return rows.map((r) => ({ status: r.status, high: r.priority === "HIGH", assigneeId: r.assigneeId, count: r._count._all }));
}

/**
 * Tickets opened and resolved in the window, the median first response (minutes) and resolutions per assignee. First
 * response is the Tickets page's definition (firstResponseAt, else the first public staff message).
 */
export async function ticketFlow(client: Db, w: Window) {
  const [opened, resolvedBy, median] = await Promise.all([
    client.supportTicket.count({ where: { createdAt: { gte: w.from, lt: w.to } } }),
    client.supportTicket.groupBy({ by: ["assigneeId"], where: { resolvedAt: { gte: w.from, lt: w.to } }, _count: { _all: true } }),
    client.$queryRaw<Array<{ minutes: unknown }>>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(0, extract(epoch FROM (r."at" - r."createdAt")) / 60)) AS "minutes"
      FROM (
        SELECT t."createdAt", ${FIRST_RESPONSE_AT_SQL} AS "at"
        FROM "SupportTicket" t
        WHERE t."createdAt" >= ${w.from}::timestamp(3) AND t."createdAt" < ${w.to}::timestamp(3)
      ) r
      WHERE r."at" IS NOT NULL`,
  ]);
  const raw = median[0]?.minutes;
  return {
    opened,
    resolved: resolvedBy.reduce((s, r) => s + r._count._all, 0),
    resolvedBy: new Map(resolvedBy.map((r) => [r.assigneeId, r._count._all])),
    medianFirstResponseMinutes: raw === null || raw === undefined ? null : Math.max(0, Math.round(sqlNumber(raw))),
  };
}

/** Active Support and Admin staff (the per-assignee rows), plus any other assignees named in `extraIds`. */
export async function workloadStaff(client: Db, extraIds: readonly string[]) {
  return client.user.findMany({
    where: {
      kind: "STAFF",
      OR: [{ staffStatus: "ACTIVE", staffRole: { in: ["SUPPORT", "ADMIN"] } }, { id: { in: [...extraIds] } }],
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, staffRole: true, staffStatus: true },
  });
}

