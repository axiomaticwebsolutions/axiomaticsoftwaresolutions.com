/**
 * CSV exports of the Reports module (GET /api/admin/reports/export.csv?report=&range=). Each builder returns a header
 * and plain rows (at most ADMIN_EXPORT_MAX_ROWS + 1, the extra row marks a cut file); the route hands them to
 * csvExportResponse(), which checks `reports.export`, writes the "Exported report" audit row and sends lib/csv output.
 *
 * Amounts are rupees with two decimals ("4999.00", excluding GST unless the column says otherwise), dates are IST
 * calendar dates ("2026-10-07") so spreadsheets sort them. License keys are masked; no export carries secrets,
 * payment ids or customer phone numbers.
 */
import "server-only";
import { LicenseStatus, PlanType } from "@/generated/prisma/client";
import { DAY_MS, formatDateIST } from "@/lib/dates";
import type { CsvValue } from "@/lib/csv";
import type { Db } from "@/lib/db";
import { maskLicenseKey } from "@/lib/licensing/keys";
import { deriveLicenseStatus, LICENSE_STATUS_META } from "@/lib/licensing/status";
import { paiseToDecimalString } from "@/lib/money";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { ADMIN_EXPORT_MAX_ROWS } from "@/lib/admin/export";
import { FIRST_STAFF_REPLY_SELECT, firstResponseOf } from "@/lib/admin/tickets/first-response";
import { LICENSE_HEALTH_ROWS } from "@/lib/admin/overview/model";
import { istDayKey, monthKeysInWindow, rangeDescription, rangeWindow, type RangeKey, type RangeWindow } from "@/lib/admin/overview/range";
import {
  REPORT_EXPORTS,
  RENEWAL_FORECAST_DAYS,
  reportFileName,
  type GstMonthRow,
  type MoneyTotals,
  type ReportExportKey,
} from "./model";
import {
  creditNotesInWindow,
  invoicedSalesByProduct,
  invoicesByMonth,
  invoicesByState,
  licenseHealthCounts,
  openTicketGroups,
  ticketFlow,
  type CreditNoteRow,
  type InvoiceAggRow,
} from "./queries";
import { monthlyRows, productDirectory, productSalesRows, supportRows } from "./service";

export type ExportTable = { header: string[]; rows: CsvValue[][] };

export type BuiltReportExport = ExportTable & {
  key: ReportExportKey;
  /** Audit target and toast name ("Sales register"). */
  title: string;
  fileName: string;
  /** What the file covers, for the audit detail ("Last 30 days (8 Sep – 7 Oct 2026)"). */
  scope: string;
};

export type ExportOptions = { range: RangeKey; now: Date; /** Default ADMIN_EXPORT_MAX_ROWS + 1. */ limit?: number };

/** Plans whose licenses renew by buying the same plan again (lib/licensing/account.ts renewalOptionsFor). */
const RENEWABLE_PLAN_TYPES = [PlanType.ANNUAL, PlanType.SUBSCRIPTION];
/** Checkout cap for per-terminal quantities (lib/licensing/account.ts). */
const PER_UNIT_MAX_QTY = 10;

const rupees = (paise: number) => paiseToDecimalString(paise);
const day = (d: Date | null | undefined) => (d ? istDayKey(d) : "");

/** "PARTIALLY_REFUNDED" -> "Partially refunded". */
export function humanizeEnum(value: string): string {
  const text = value.toLowerCase().replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The customer column of order-based exports: business name, else the buyer's name, else the order email. */
export function orderCustomer(billing: unknown, email: string): string {
  const b = readBillingSnapshot(billing);
  return b.business?.trim() || b.name.trim() || email;
}

/** Renewal value of a time-limited license: its plan price, times the terminals for per-unit plans. */
export function renewalValuePaise(plan: { pricePaise: number; perUnit: string | null; maxQty: number | null }, deviceLimit: number): number {
  const qty = plan.perUnit ? Math.max(1, Math.min(deviceLimit, plan.maxQty ?? PER_UNIT_MAX_QTY)) : 1;
  return plan.pricePaise * qty;
}

function money(t: Pick<MoneyTotals, "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise">): CsvValue[] {
  const tax = t.cgstPaise + t.sgstPaise + t.igstPaise;
  return [rupees(t.taxablePaise), rupees(t.cgstPaise), rupees(t.sgstPaise), rupees(t.igstPaise), rupees(t.taxablePaise + tax)];
}

function aggTotals(rows: readonly InvoiceAggRow[]) {
  return rows.reduce(
    (s, r) => ({ count: s.count + r.count, taxablePaise: s.taxablePaise + r.taxablePaise, cgstPaise: s.cgstPaise + r.cgstPaise, sgstPaise: s.sgstPaise + r.sgstPaise, igstPaise: s.igstPaise + r.igstPaise }),
    { count: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
  );
}

// ---------- Prototype export cards ----------

/** Every tax invoice issued in the range (refunded orders included; their credit notes are in "Refunds"). */
async function salesRegister(client: Db, win: RangeWindow, limit: number): Promise<ExportTable> {
  const invoices = await client.invoice.findMany({
    where: { issuedAt: { gte: win.from, lt: win.to } },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      number: true,
      issuedAt: true,
      order: {
        select: { id: true, email: true, billing: true, placeOfSupply: true, status: true, taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true },
      },
    },
  });
  return {
    header: ["Invoice", "Order", "Date", "Customer", "GSTIN", "State", "Taxable", "CGST", "SGST", "IGST", "Total", "Order status"],
    rows: invoices.map(({ number, issuedAt, order: o }) => [
      number,
      o.id,
      day(issuedAt),
      orderCustomer(o.billing, o.email),
      readBillingSnapshot(o.billing).gstin ?? "",
      o.placeOfSupply,
      rupees(o.taxablePaise),
      rupees(o.cgstPaise),
      rupees(o.sgstPaise),
      rupees(o.igstPaise),
      rupees(o.totalPaise),
      humanizeEnum(o.status),
    ]),
  };
}

/** Tax invoices and credit notes per place of supply (separate rows, as GSTR-1 reports them). */
async function gstByState(client: Db, win: RangeWindow, limit: number): Promise<ExportTable> {
  const [invoices, notes] = await Promise.all([invoicesByState(client, win), creditNotesInWindow(client, win, limit)]);
  const credits = new Map<string, InvoiceAggRow>();
  for (const n of notes) {
    const key = n.order.placeOfSupply;
    const row = credits.get(key) ?? { key, count: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
    row.count += 1;
    row.taxablePaise += n.split.taxablePaise;
    row.cgstPaise += n.split.cgstPaise;
    row.sgstPaise += n.split.sgstPaise;
    row.igstPaise += n.split.igstPaise;
    credits.set(key, row);
  }
  const states = [...new Set([...invoices.map((r) => r.key), ...credits.keys()])].sort((a, b) => a.localeCompare(b));
  const byState = new Map(invoices.map((r) => [r.key, r]));
  const rows: CsvValue[][] = [];
  for (const state of states) {
    const inv = byState.get(state);
    if (inv) rows.push([state, "Tax invoices", inv.count, ...money(inv)]);
    const cn = credits.get(state);
    if (cn) rows.push([state, "Credit notes", cn.count, ...money(cn)]);
  }
  const invTotal = aggTotals(invoices);
  const cnTotal = aggTotals([...credits.values()]);
  rows.push(["All states", "Tax invoices", invTotal.count, ...money(invTotal)]);
  rows.push(["All states", "Credit notes", cnTotal.count, ...money(cnTotal)]);
  return { header: ["State", "Document", "Count", "Taxable", "CGST", "SGST", "IGST", "Total"], rows };
}

/** Credit notes issued in the range (pending or processed refunds). */
async function refundsRegister(client: Db, win: RangeWindow, limit: number): Promise<ExportTable> {
  const notes = await creditNotesInWindow(client, win, limit);
  return {
    header: ["Credit note", "Order", "Invoice", "Date", "Refund status", "Processed", "Customer", "State", "Taxable", "CGST", "SGST", "IGST", "Amount"],
    rows: notes.map((n: CreditNoteRow) => [
      n.number,
      n.order.id,
      n.order.invoiceNumber ?? "",
      day(n.issuedAt),
      humanizeEnum(n.status),
      day(n.processedAt),
      orderCustomer(n.order.billing, n.order.email),
      n.order.placeOfSupply,
      ...money(n.split),
    ]),
  };
}

const LICENSE_EXPORT_SELECT = {
  id: true,
  status: true,
  issuedAt: true,
  expiresAt: true,
  updatesUntil: true,
  deviceLimit: true,
  keyLast4: true,
  orderId: true,
  product: { select: { shortName: true, code: true } },
  plan: { select: { name: true, type: true, pricePaise: true, perUnit: true, maxQty: true } },
  account: { select: { legalName: true } },
  _count: { select: { devices: { where: { deactivatedAt: null } } } },
} as const;

/** Order emails of guest licenses (the customer column when no account has claimed them yet). */
async function orderEmails(client: Db, orderIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(orderIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const orders = await client.order.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
  return new Map(orders.map((o) => [o.id, o.email]));
}

/** Every license (oldest first) with its derived status and active devices. Keys are masked. */
async function licenseRegister(client: Db, now: Date, limit: number): Promise<ExportTable> {
  const licenses = await client.license.findMany({ orderBy: [{ issuedAt: "asc" }, { id: "asc" }], take: limit, select: LICENSE_EXPORT_SELECT });
  const emails = await orderEmails(client, licenses.map((l) => l.orderId));
  return {
    header: ["License", "Product", "Plan", "Key", "Customer", "Order email", "Status", "Issued", "Expires", "Updates until", "Devices"],
    rows: licenses.map((l) => [
      l.id,
      l.product.shortName,
      l.plan.name,
      maskLicenseKey(l.product.code, l.keyLast4),
      l.account?.legalName ?? "Guest (not claimed)",
      l.orderId ? (emails.get(l.orderId) ?? "") : "",
      LICENSE_STATUS_META[deriveLicenseStatus(l, now)].adminLabel,
      day(l.issuedAt),
      l.expiresAt ? day(l.expiresAt) : "No end date",
      day(l.updatesUntil),
      `${l._count.devices}/${l.deviceLimit}`,
    ]),
  };
}

/** Active annual and subscription licenses ending in the next 90 days, soonest first, with their renewal value. */
async function renewalForecast(client: Db, now: Date, limit: number): Promise<ExportTable> {
  const until = new Date(now.getTime() + RENEWAL_FORECAST_DAYS * DAY_MS);
  const licenses = await client.license.findMany({
    where: { status: LicenseStatus.ACTIVE, expiresAt: { gt: now, lte: until }, plan: { type: { in: RENEWABLE_PLAN_TYPES } } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: limit,
    select: LICENSE_EXPORT_SELECT,
  });
  const emails = await orderEmails(client, licenses.map((l) => l.orderId));
  return {
    header: ["License", "Product", "Plan", "Customer", "Order email", "Ends", "Days left", "Devices", "Renewal value (excl. GST)"],
    rows: licenses.map((l) => [
      l.id,
      l.product.shortName,
      l.plan.name,
      l.account?.legalName ?? "Guest (not claimed)",
      l.orderId ? (emails.get(l.orderId) ?? "") : "",
      day(l.expiresAt),
      l.expiresAt ? Math.max(0, Math.ceil((l.expiresAt.getTime() - now.getTime()) / DAY_MS)) : "",
      `${l._count.devices}/${l.deviceLimit}`,
      rupees(renewalValuePaise(l.plan, l.deviceLimit)),
    ]),
  };
}

/**
 * Tickets opened in the range with priority, status, assignee and response times (hours, one decimal). First response
 * is the Tickets page's definition (firstResponseAt, else the first public staff message).
 */
async function supportSla(client: Db, win: RangeWindow, limit: number): Promise<ExportTable> {
  const tickets = await client.supportTicket.findMany({
    where: { createdAt: { gte: win.from, lt: win.to } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      subject: true,
      priority: true,
      status: true,
      createdAt: true,
      firstResponseAt: true,
      resolvedAt: true,
      account: { select: { legalName: true } },
      assignee: { select: { name: true } },
      messages: FIRST_STAFF_REPLY_SELECT,
    },
  });
  const hours = (from: Date, to: Date | null) => (to ? (Math.max(0, to.getTime() - from.getTime()) / 3_600_000).toFixed(1) : "");
  return {
    header: ["Ticket", "Subject", "Customer", "Priority", "Status", "Assignee", "Opened", "First response", "Hours to first response", "Resolved", "Hours to resolve"],
    rows: tickets.map((t) => {
      const first = firstResponseOf(t);
      return [
        t.id,
        t.subject,
        t.account.legalName,
        humanizeEnum(t.priority),
        humanizeEnum(t.status),
        t.assignee?.name ?? "Unassigned",
        day(t.createdAt),
        day(first),
        hours(t.createdAt, first),
        day(t.resolvedAt),
        hours(t.createdAt, t.resolvedAt),
      ];
    }),
  };
}

// ---------- On-page reports ----------

async function monthly(client: Db, win: RangeWindow) {
  const [invoices, notes] = await Promise.all([invoicesByMonth(client, win), creditNotesInWindow(client, win)]);
  return { ...monthlyRows(monthKeysInWindow(win), invoices, notes, win.from), notes };
}

async function salesByMonth(client: Db, win: RangeWindow): Promise<ExportTable> {
  const { salesByMonth: s } = await monthly(client, win);
  const line = (r: (typeof s.rows)[number]): CsvValue[] => [
    r.label,
    r.invoices,
    rupees(r.taxablePaise),
    rupees(r.gstPaise),
    rupees(r.valuePaise),
    r.creditNotes,
    rupees(r.creditTaxablePaise),
    rupees(r.netTaxablePaise),
  ];
  return {
    header: ["Month", "Invoices", "Taxable", "GST", "Invoice value", "Credit notes", "Credit note taxable", "Net taxable"],
    rows: [...s.rows.map(line), line(s.total)],
  };
}

async function gstByMonth(client: Db, win: RangeWindow): Promise<ExportTable> {
  const { gstByMonth: g } = await monthly(client, win);
  const line = (doc: string) => (r: GstMonthRow): CsvValue[] => [
    r.key === "total" ? "Total" : r.label,
    doc,
    r.count,
    rupees(r.taxablePaise),
    rupees(r.cgstPaise),
    rupees(r.sgstPaise),
    rupees(r.igstPaise),
    rupees(r.taxPaise),
    rupees(r.valuePaise),
  ];
  const net = {
    taxablePaise: g.invoiceTotal.taxablePaise - g.creditTotal.taxablePaise,
    cgstPaise: g.invoiceTotal.cgstPaise - g.creditTotal.cgstPaise,
    sgstPaise: g.invoiceTotal.sgstPaise - g.creditTotal.sgstPaise,
    igstPaise: g.invoiceTotal.igstPaise - g.creditTotal.igstPaise,
  };
  const netTax = net.cgstPaise + net.sgstPaise + net.igstPaise;
  return {
    header: ["Month", "Document", "Count", "Taxable", "CGST", "SGST", "IGST", "Total tax", "Total"],
    rows: [
      ...g.invoices.map(line("Tax invoices")),
      line("Tax invoices")(g.invoiceTotal),
      ...g.creditNotes.map(line("Credit notes")),
      line("Credit notes")(g.creditTotal),
      ["Net", "Invoices less credit notes", "", rupees(net.taxablePaise), rupees(net.cgstPaise), rupees(net.sgstPaise), rupees(net.igstPaise), rupees(netTax), rupees(net.taxablePaise + netTax)],
    ],
  };
}

async function salesByProduct(client: Db, win: RangeWindow): Promise<ExportTable> {
  const [sales, notes, products, invoiceCount] = await Promise.all([
    invoicedSalesByProduct(client, win),
    creditNotesInWindow(client, win),
    productDirectory(client),
    client.invoice.count({ where: { issuedAt: { gte: win.from, lt: win.to } } }),
  ]);
  const { rows, total } = productSalesRows(products, sales, notes, invoiceCount);
  const line = (r: (typeof rows)[number]): CsvValue[] => [r.name, r.orders, rupees(r.taxablePaise), rupees(r.creditPaise), rupees(r.netPaise)];
  return { header: ["Product", "Invoiced orders", "Taxable", "Credit notes", "Net taxable"], rows: [...rows.map(line), line(total)] };
}

async function licenseHealth(client: Db, now: Date): Promise<ExportTable> {
  const [health, products] = await Promise.all([licenseHealthCounts(client, now), productDirectory(client)]);
  const statuses = LICENSE_HEALTH_ROWS.map((r) => r.key);
  const rows: CsvValue[][] = products.flatMap((p) => {
    const counts = health.byProduct.get(p.id);
    if (!counts) return [];
    const total = statuses.reduce((s, k) => s + counts[k], 0);
    return total > 0 ? [[p.name, ...statuses.map((k) => counts[k]), total]] : [];
  });
  rows.push(["Total", ...statuses.map((k) => health.totals[k]), statuses.reduce((s, k) => s + health.totals[k], 0)]);
  return { header: ["Product", ...statuses.map((k) => LICENSE_STATUS_META[k].adminLabel), "Total"], rows };
}

async function supportWorkload(client: Db, win: RangeWindow): Promise<ExportTable> {
  const [flow, tickets] = await Promise.all([ticketFlow(client, win), openTicketGroups(client)]);
  const support = await supportRows(client, tickets, flow.resolvedBy);
  const rows: CsvValue[][] = support.assignees.map((a) => [a.name, a.role, a.open, a.awaitingCustomer, a.high, a.resolved]);
  rows.push(["Total", "", support.waitingOnUs, support.waitingOnCustomer, support.highPriority, flow.resolved]);
  return { header: ["Assignee", "Role", "Waiting on us", "Waiting on customer", "High priority", "Resolved in period"], rows };
}

// ---------- Dispatcher ----------

/** What a file covers: the range ("Last 30 days (8 Sep – 7 Oct 2026)"), every license, or a date-bound view. */
export function exportScope(key: ReportExportKey, win: RangeWindow, now: Date): string {
  switch (REPORT_EXPORTS[key].scope) {
    case "range":
      return rangeDescription(win);
    case "all":
      return `All licenses on ${formatDateIST(now)}`;
    case "next90":
      return `Ending ${formatDateIST(now)} \u2013 ${formatDateIST(new Date(now.getTime() + RENEWAL_FORECAST_DAYS * DAY_MS))}`;
    case "now":
      return `As on ${formatDateIST(now)}`;
  }
}

/** Builds one report export for `range` at `now`. */
export async function buildReportExport(client: Db, key: ReportExportKey, opts: ExportOptions): Promise<BuiltReportExport> {
  const { now } = opts;
  const limit = Math.max(1, opts.limit ?? ADMIN_EXPORT_MAX_ROWS + 1);
  const win = rangeWindow(opts.range, now);
  let table: ExportTable;
  switch (key) {
    case "sales-register":
      table = await salesRegister(client, win, limit);
      break;
    case "gst-by-state":
      table = await gstByState(client, win, limit);
      break;
    case "refunds":
      table = await refundsRegister(client, win, limit);
      break;
    case "license-register":
      table = await licenseRegister(client, now, limit);
      break;
    case "renewal-forecast":
      table = await renewalForecast(client, now, limit);
      break;
    case "support-sla":
      table = await supportSla(client, win, limit);
      break;
    case "sales-by-month":
      table = await salesByMonth(client, win);
      break;
    case "gst-by-month":
      table = await gstByMonth(client, win);
      break;
    case "sales-by-product":
      table = await salesByProduct(client, win);
      break;
    case "license-health":
      table = await licenseHealth(client, now);
      break;
    case "support-workload":
      table = await supportWorkload(client, win);
      break;
  }
  return {
    ...table,
    key,
    title: REPORT_EXPORTS[key].title,
    fileName: reportFileName(key, opts.range, istDayKey(now)),
    scope: exportScope(key, win, now),
  };
}
