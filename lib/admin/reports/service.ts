/**
 * Admin Reports data (GET /api/admin/reports and the /admin/reports page; decisions.md Phase 6 "Reports"): sales by
 * month and by product, the GST summary by month with credit notes kept apart, license health per product and the
 * support workload, for one 7d / 30d / 90d / 12m range in IST (lib/admin/overview/range.ts). Accounting rules are in
 * ./model.ts. Months are the IST calendar months the range touches, cut to the range (12m covers whole months).
 */
import "server-only";
import { TicketStatus } from "@/generated/prisma/client";
import { getSetting } from "@/lib/config";
import type { Db } from "@/lib/db";
import type { DerivedLicenseStatus } from "@/lib/licensing/status";
import { STAFF_ROLE_LABELS } from "@/lib/rbac";
import { assigneeNames, OVERVIEW_COPY, toneOf } from "@/lib/admin/overview/model";
import {
  istMonthKey,
  monthKeysInWindow,
  rangeDescription,
  rangeWindow,
  windowMonthLabel,
  type RangeKey,
} from "@/lib/admin/overview/range";
import {
  addSplit,
  emptyHealthCounts,
  emptyTotals,
  type GstMonthRow,
  type ProductHealthRow,
  type ProductSalesRow,
  type ReportsData,
  type SalesMonthRow,
  type SupportAssigneeRow,
} from "./model";
import {
  creditNotesInWindow,
  invoicedSalesByProduct,
  invoicesByMonth,
  licenseHealthCounts,
  openTicketGroups,
  ticketFlow,
  workloadStaff,
  type CreditNoteRow,
} from "./queries";

export type ReportsOptions = { range: RangeKey; now: Date };

/** Products in catalogue order with their display name and tone. */
export async function productDirectory(client: Db) {
  const products = await client.product.findMany({
    orderBy: [{ rank: "asc" }, { id: "asc" }],
    select: { id: true, shortName: true, tone: true, category: { select: { tone: true } } },
  });
  return products.map((p) => ({ id: p.id, name: p.shortName, tone: toneOf(p.tone ?? p.category.tone) }));
}

function salesRow(key: string, label: string): SalesMonthRow {
  return { key, label, invoices: 0, taxablePaise: 0, gstPaise: 0, valuePaise: 0, creditNotes: 0, creditTaxablePaise: 0, netTaxablePaise: 0 };
}

function gstRow(key: string, label: string): GstMonthRow {
  return { key, label, count: 0, ...emptyTotals() };
}

/** Credit notes per IST month of issue. */
function creditNotesByMonth(notes: readonly CreditNoteRow[], windowFrom: Date | null): Map<string, GstMonthRow> {
  const out = new Map<string, GstMonthRow>();
  for (const note of notes) {
    const key = istMonthKey(note.issuedAt);
    const row = out.get(key) ?? gstRow(key, windowMonthLabel(key, windowFrom));
    row.count += 1;
    addSplit(row, note.split);
    out.set(key, row);
  }
  return out;
}

const SALES_SUM_KEYS = ["invoices", "taxablePaise", "gstPaise", "valuePaise", "creditNotes", "creditTaxablePaise", "netTaxablePaise"] as const;

/**
 * Sales and GST rows per month of the window (every month listed, empty ones as zero rows). `windowFrom` marks a
 * first month that the range cuts.
 */
export function monthlyRows(
  months: readonly string[],
  invoices: Awaited<ReturnType<typeof invoicesByMonth>>,
  notes: readonly CreditNoteRow[],
  windowFrom: Date | null = null,
) {
  const invoiceByKey = new Map(invoices.map((r) => [r.key, r]));
  const creditByKey = creditNotesByMonth(notes, windowFrom);
  const salesTotal = salesRow("total", "Total");
  const salesRows = months.map((key) => {
    const row = salesRow(key, windowMonthLabel(key, windowFrom));
    const inv = invoiceByKey.get(key);
    if (inv) {
      const gst = inv.cgstPaise + inv.sgstPaise + inv.igstPaise;
      row.invoices = inv.count;
      row.taxablePaise = inv.taxablePaise;
      row.gstPaise = gst;
      row.valuePaise = inv.taxablePaise + gst;
    }
    const credit = creditByKey.get(key);
    if (credit) {
      row.creditNotes = credit.count;
      row.creditTaxablePaise = credit.taxablePaise;
    }
    row.netTaxablePaise = row.taxablePaise - row.creditTaxablePaise;
    for (const k of SALES_SUM_KEYS) salesTotal[k] += row[k];
    return row;
  });

  const invoiceTotal = gstRow("total", "Total");
  const gstInvoices = months.map((key) => {
    const row = gstRow(key, windowMonthLabel(key, windowFrom));
    const inv = invoiceByKey.get(key);
    if (inv) {
      row.count = inv.count;
      addSplit(row, inv);
      invoiceTotal.count += inv.count;
      addSplit(invoiceTotal, inv);
    }
    return row;
  });
  const creditTotal = gstRow("total", "Total");
  const gstCredits = months.flatMap((key) => {
    const row = creditByKey.get(key);
    if (!row) return [];
    creditTotal.count += row.count;
    addSplit(creditTotal, row);
    return [row];
  });
  return {
    salesByMonth: { rows: salesRows, total: salesTotal },
    gstByMonth: { invoices: gstInvoices, invoiceTotal, creditNotes: gstCredits, creditTotal, netTaxPaise: invoiceTotal.taxPaise - creditTotal.taxPaise },
  };
}

type Directory = Awaited<ReturnType<typeof productDirectory>>;

/** Invoiced line values per product with credit notes by the refunded order's line shares, highest net first. */
export function productSalesRows(
  products: Directory,
  sales: ReadonlyMap<string, { orders: number; taxablePaise: number }>,
  notes: readonly CreditNoteRow[],
  invoiceCount: number,
): ReportsData["salesByProduct"] {
  const creditByProduct = new Map<string, number>();
  for (const note of notes) {
    for (const [id, paise] of note.byProduct) creditByProduct.set(id, (creditByProduct.get(id) ?? 0) + paise);
  }
  const rows: ProductSalesRow[] = products
    .map((p) => {
      const s = sales.get(p.id);
      const credit = creditByProduct.get(p.id) ?? 0;
      const taxable = s?.taxablePaise ?? 0;
      return { productId: p.id, name: p.name, tone: p.tone, orders: s?.orders ?? 0, taxablePaise: taxable, creditPaise: credit, netPaise: taxable - credit };
    })
    .filter((r) => r.orders > 0 || r.creditPaise > 0)
    .sort((a, b) => b.netPaise - a.netPaise);
  const total: ProductSalesRow = { productId: "total", name: "Total", tone: "lavender", orders: invoiceCount, taxablePaise: 0, creditPaise: 0, netPaise: 0 };
  for (const r of rows) {
    total.taxablePaise += r.taxablePaise;
    total.creditPaise += r.creditPaise;
    total.netPaise += r.netPaise;
  }
  return { rows, total };
}

type OpenCounts = { open: number; awaiting: number; high: number };

/** Open tickets per assignee today and resolutions in the range, plus the Unassigned row. */
export async function supportRows(
  client: Db,
  tickets: Awaited<ReturnType<typeof openTicketGroups>>,
  resolvedBy: ReadonlyMap<string | null, number>,
): Promise<{ assignees: SupportAssigneeRow[]; waitingOnUs: number; waitingOnCustomer: number; highPriority: number }> {
  const open = new Map<string | null, OpenCounts>();
  for (const t of tickets) {
    const row = open.get(t.assigneeId) ?? { open: 0, awaiting: 0, high: 0 };
    if (t.status === TicketStatus.OPEN) row.open += t.count;
    else row.awaiting += t.count;
    if (t.high) row.high += t.count;
    open.set(t.assigneeId, row);
  }
  const ids = new Set<string>();
  for (const id of [...open.keys(), ...resolvedBy.keys()]) if (id) ids.add(id);
  const staff = await workloadStaff(client, [...ids]);
  const names = assigneeNames(staff);
  const row = (id: string | null, name: string, role: string): SupportAssigneeRow => {
    const o = open.get(id);
    return { id, name, role, open: o?.open ?? 0, awaitingCustomer: o?.awaiting ?? 0, high: o?.high ?? 0, resolved: resolvedBy.get(id) ?? 0 };
  };
  const assignees = staff.map((s) => row(s.id, names.get(s.id) ?? s.name, s.staffRole ? STAFF_ROLE_LABELS[s.staffRole] : ""));
  assignees.push(row(null, OVERVIEW_COPY.unassigned, ""));
  const sum = (pick: (r: OpenCounts) => number) => [...open.values()].reduce((s, r) => s + pick(r), 0);
  return { assignees, waitingOnUs: sum((r) => r.open), waitingOnCustomer: sum((r) => r.awaiting), highPriority: sum((r) => r.high) };
}

export async function getAdminReports(client: Db, opts: ReportsOptions): Promise<ReportsData> {
  const { now } = opts;
  const win = rangeWindow(opts.range, now);
  const w = { from: win.from, to: win.to };
  const [business, invoiceMonths, notes, productSales, products, health, flow, tickets] = await Promise.all([
    getSetting(client, "business"),
    invoicesByMonth(client, w),
    creditNotesInWindow(client, w),
    invoicedSalesByProduct(client, w),
    productDirectory(client),
    licenseHealthCounts(client, now),
    ticketFlow(client, w),
    openTicketGroups(client),
  ]);

  const monthly = monthlyRows(monthKeysInWindow(win), invoiceMonths, notes, win.from);
  const salesByProduct = productSalesRows(products, productSales, notes, monthly.gstByMonth.invoiceTotal.count);

  const byProduct: ProductHealthRow[] = products.flatMap((p) => {
    const counts = health.byProduct.get(p.id);
    if (!counts) return [];
    const total = (Object.keys(counts) as DerivedLicenseStatus[]).reduce((s, k) => s + counts[k], 0);
    return total > 0 ? [{ productId: p.id, name: p.name, counts: { ...counts }, total }] : [];
  });
  const healthTotal = (Object.keys(health.totals) as DerivedLicenseStatus[]).reduce((s, k) => s + health.totals[k], 0);

  const support = await supportRows(client, tickets, flow.resolvedBy);

  return {
    range: opts.range,
    generatedAt: now.toISOString(),
    sample: business.sample,
    scope: rangeDescription(win),
    ...monthly,
    salesByProduct,
    licenseHealth: { counts: { ...emptyHealthCounts(), ...health.totals }, total: healthTotal, byProduct },
    support: {
      opened: flow.opened,
      resolved: flow.resolved,
      medianFirstResponseMinutes: flow.medianFirstResponseMinutes,
      waitingOnUs: support.waitingOnUs,
      waitingOnCustomer: support.waitingOnCustomer,
      highPriority: support.highPriority,
      assignees: support.assignees,
    },
  };
}
