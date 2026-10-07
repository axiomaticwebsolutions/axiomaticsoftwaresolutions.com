/**
 * Admin Reports read model (Admin Console.dc.html `mods.reports`, decisions.md Phase 6 "Reports"): the on-page reports
 * (sales by month and product, GST summary by month with credit notes shown separately, license health, support
 * workload) and the CSV export catalogue. Pure and client-safe.
 *
 * Accounting rules:
 * - Sales and GST come from tax invoices by issue date (Invoice.issuedAt = Order.paidAt, IST months). An invoice stays
 *   in its month after a refund; the refund is a credit note in the month it was issued (Refund.createdAt), never
 *   netted into the invoice row (GSTR-1 reports both separately).
 * - A credit note's taxable value and CGST/SGST/IGST are its amount split in proportion to the order's own split
 *   (largest remainder, exact paise), so a full refund reverses the invoice exactly.
 * - Credit notes count while PENDING or PROCESSED (the number is issued with the refund); FAILED refunds are left out.
 */
import type { DerivedLicenseStatus } from "@/lib/licensing/status";
import type { IconSourceName } from "@/components/icons/icon-names";
import type { Tone } from "@/lib/design/tokens";
import { allocateLargestRemainder } from "@/lib/pricing";
import type { RangeKey } from "@/lib/admin/overview/range";

export type TaxSplit = { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number };

/** The tax split of `amountPaise` refunded from an order (capped at the order total). */
export function refundSplit(amountPaise: number, order: TaxSplit & { totalPaise: number }): TaxSplit {
  const amount = Math.max(0, Math.min(Math.trunc(amountPaise), order.totalPaise));
  const [taxablePaise = 0, cgstPaise = 0, sgstPaise = 0, igstPaise = 0] = allocateLargestRemainder(amount, [
    Math.max(0, order.taxablePaise),
    Math.max(0, order.cgstPaise),
    Math.max(0, order.sgstPaise),
    Math.max(0, order.igstPaise),
  ]);
  return { taxablePaise, cgstPaise, sgstPaise, igstPaise };
}

/** `totalPaise` shared over lines in proportion to their weights (exact paise). */
export function splitOverLines(totalPaise: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  return allocateLargestRemainder(Math.max(0, Math.trunc(totalPaise)), weights.map((w) => Math.max(0, Math.trunc(w))));
}

export type MoneyTotals = TaxSplit & { taxPaise: number; valuePaise: number };

export function emptyTotals(): MoneyTotals {
  return { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0, valuePaise: 0 };
}

/** Adds a split into running totals (tax = CGST + SGST + IGST, value = taxable + tax). */
export function addSplit(into: MoneyTotals, split: TaxSplit): MoneyTotals {
  into.taxablePaise += split.taxablePaise;
  into.cgstPaise += split.cgstPaise;
  into.sgstPaise += split.sgstPaise;
  into.igstPaise += split.igstPaise;
  const tax = split.cgstPaise + split.sgstPaise + split.igstPaise;
  into.taxPaise += tax;
  into.valuePaise += split.taxablePaise + tax;
  return into;
}

// ---------- Report data (GET /api/admin/reports) ----------

export type SalesMonthRow = {
  key: string;
  label: string;
  invoices: number;
  taxablePaise: number;
  gstPaise: number;
  valuePaise: number;
  creditNotes: number;
  creditTaxablePaise: number;
  netTaxablePaise: number;
};

export type GstMonthRow = MoneyTotals & { key: string; label: string; count: number };

export type ProductSalesRow = {
  productId: string;
  name: string;
  tone: Tone;
  orders: number;
  taxablePaise: number;
  creditPaise: number;
  netPaise: number;
};

export type LicenseHealthCounts = Record<DerivedLicenseStatus, number>;

export type ProductHealthRow = { productId: string; name: string; counts: LicenseHealthCounts; total: number };

export type SupportAssigneeRow = {
  id: string | null;
  name: string;
  role: string;
  open: number;
  awaitingCustomer: number;
  high: number;
  resolved: number;
};

export type ReportsData = {
  range: RangeKey;
  generatedAt: string;
  sample: boolean;
  /** "Last 30 days (8 Sep – 7 Oct 2026)". */
  scope: string;
  salesByMonth: { rows: SalesMonthRow[]; total: SalesMonthRow };
  gstByMonth: { invoices: GstMonthRow[]; invoiceTotal: GstMonthRow; creditNotes: GstMonthRow[]; creditTotal: GstMonthRow; netTaxPaise: number };
  salesByProduct: { rows: ProductSalesRow[]; total: ProductSalesRow };
  licenseHealth: { counts: LicenseHealthCounts; total: number; byProduct: ProductHealthRow[] };
  support: {
    opened: number;
    resolved: number;
    /** Median minutes from opening to the first staff reply, tickets opened in the range (null: none answered). */
    medianFirstResponseMinutes: number | null;
    waitingOnUs: number;
    waitingOnCustomer: number;
    highPriority: number;
    assignees: SupportAssigneeRow[];
  };
};

export function emptyHealthCounts(): LicenseHealthCounts {
  return { active: 0, expiring: 0, trial: 0, expired: 0, suspended: 0, revoked: 0 };
}

// ---------- CSV exports (GET /api/admin/reports/export.csv?report=&range=) ----------

export const REPORT_EXPORT_KEYS = [
  "sales-register",
  "gst-by-state",
  "refunds",
  "license-register",
  "renewal-forecast",
  "support-sla",
  "sales-by-month",
  "gst-by-month",
  "sales-by-product",
  "license-health",
  "support-workload",
] as const;

export type ReportExportKey = (typeof REPORT_EXPORT_KEYS)[number];

/** What an export covers: the selected range, every license, the next 90 days or the current state. */
export type ReportScope = "range" | "all" | "next90" | "now";

export type ReportExportMeta = {
  title: string;
  description: string;
  icon: IconSourceName;
  tone: Tone;
  scope: ReportScope;
  /** One of the prototype's export cards (the others are the on-page reports' own exports). */
  card: boolean;
};

/** Renewal forecast window (prototype: licenses ending in the next 90 days). */
export const RENEWAL_FORECAST_DAYS = 90;

export const REPORT_EXPORTS: Readonly<Record<ReportExportKey, ReportExportMeta>> = Object.freeze({
  "sales-register": {
    title: "Sales register",
    description: "Every paid order with invoice number, taxable value and GST split.",
    icon: "payments",
    tone: "sage",
    scope: "range",
    card: true,
  },
  "gst-by-state": {
    title: "GST summary by state",
    description: "Taxable value and tax collected per place of supply, for GSTR filing.",
    icon: "summarize",
    tone: "blue",
    scope: "range",
    card: true,
  },
  refunds: {
    title: "Refunds & credit notes",
    description: "Refunded orders with dates and amounts.",
    icon: "currency_exchange",
    tone: "lavender",
    scope: "range",
    card: true,
  },
  "license-register": {
    title: "License register",
    description: "All licenses with status, expiry and device usage. Keys are masked.",
    icon: "key",
    tone: "peach",
    scope: "all",
    card: true,
  },
  "renewal-forecast": {
    title: "Renewal forecast",
    description: "Licenses ending in the next 90 days with renewal value.",
    icon: "event_upcoming",
    tone: "pink",
    scope: "next90",
    card: true,
  },
  "support-sla": {
    title: "Support SLA",
    description: "Tickets with priority, assignee and status.",
    icon: "support_agent",
    tone: "blue",
    scope: "range",
    card: true,
  },
  "sales-by-month": {
    title: "Sales by month",
    description: "Invoices issued each month with taxable value, GST and credit notes.",
    icon: "bar_chart",
    tone: "sage",
    scope: "range",
    card: false,
  },
  "gst-by-month": {
    title: "GST summary by month",
    description: "Invoices and credit notes per month with CGST, SGST and IGST, for GSTR-1 preparation.",
    icon: "summarize",
    tone: "blue",
    scope: "range",
    card: false,
  },
  "sales-by-product": {
    title: "Sales by product",
    description: "Invoiced taxable value per product, with credit notes.",
    icon: "inventory_2",
    tone: "lavender",
    scope: "range",
    card: false,
  },
  "license-health": {
    title: "License health",
    description: "Licenses per product by status today.",
    icon: "key",
    tone: "peach",
    scope: "now",
    card: false,
  },
  "support-workload": {
    title: "Support workload",
    description: "Open tickets per assignee and tickets resolved in the period.",
    icon: "support_agent",
    tone: "pink",
    scope: "range",
    card: false,
  },
});

export function isReportExportKey(value: unknown): value is ReportExportKey {
  return typeof value === "string" && (REPORT_EXPORT_KEYS as readonly string[]).includes(value);
}

/** The prototype's export cards, in its order. */
export const REPORT_CARD_KEYS = REPORT_EXPORT_KEYS.filter((key) => REPORT_EXPORTS[key].card);

/** "Last 30 days" / "All licenses" / "Next 90 days" / "Today". */
export function reportScopeLabel(scope: ReportScope, rangeLastLabel: string): string {
  if (scope === "range") return rangeLastLabel;
  if (scope === "all") return "All licenses";
  if (scope === "next90") return `Next ${RENEWAL_FORECAST_DAYS} days`;
  return "Today";
}

/** Card meta line (prototype "CSV · sample data"): "CSV · Last 30 days", plus "sample data" while it is. */
export function reportCardMeta(scope: ReportScope, rangeLastLabel: string, sample: boolean): string {
  return ["CSV", reportScopeLabel(scope, rangeLastLabel), sample ? "sample data" : null].filter(Boolean).join(" \u00B7 ");
}

/** File name part per scope: the range key, "all", "next90" or nothing (today's state). */
const SCOPE_FILE_PART: Readonly<Record<Exclude<ReportScope, "range">, string | null>> = { all: "all", next90: "next90", now: null };

/**
 * "sales-register-30d-2026-10-07.csv", "license-register-all-2026-10-07.csv", "renewal-forecast-next90-2026-10-07.csv",
 * "license-health-2026-10-07.csv" (IST date). The scope part also keeps names such as "license-register-2026" from
 * looking like a license key to the audit and log redaction (lib/licensing/keys.ts redactLicenseKeys).
 */
export function reportFileName(key: ReportExportKey, range: RangeKey, istDay: string): string {
  const scope = REPORT_EXPORTS[key].scope;
  const part = scope === "range" ? range : SCOPE_FILE_PART[scope];
  return `${[key, part, istDay].filter(Boolean).join("-")}.csv`;
}

/** Prototype toast "Exported {n} rows · {file}"; a capped file says so. */
export function exportToastText(rows: number, fileName: string, truncated: boolean): string {
  const count = `${rows.toLocaleString("en-IN")} ${rows === 1 ? "row" : "rows"}`;
  return truncated ? `Exported the first ${count} \u00B7 ${fileName}` : `Exported ${count} \u00B7 ${fileName}`;
}

/** Same-origin export path for a report and range. */
export function reportExportPath(key: ReportExportKey, range: RangeKey): string {
  return `/api/admin/reports/export.csv?report=${encodeURIComponent(key)}&range=${encodeURIComponent(range)}`;
}

// ---------- On-page copy ----------

export const REPORTS_COPY = {
  salesByMonth: "Sales by month",
  salesByProduct: "Sales by product",
  gstByMonth: "GST summary by month",
  creditNotes: "Credit notes",
  licenseHealth: "License health",
  support: "Support workload",
  noInvoices: "No invoices in this period.",
  noCreditNotes: "No credit notes issued in this period.",
  noLicenses: "No licenses yet.",
} as const;

/** Toolbar note: "Last 30 days (8 Sep – 7 Oct 2026) · amounts exclude GST unless noted", "Sample data · " first while sample. */
export function reportsNote(scope: string, sample: boolean): string {
  return `${sample ? "Sample data \u00B7 " : ""}${scope} \u00B7 amounts exclude GST unless noted`;
}

/** Median first response: "45 min", "3 h 20 min", "2 d 4 h"; an em dash when no ticket was answered. */
export function durationText(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "\u2014";
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 1440) {
    const rest = m % 60;
    return rest ? `${Math.floor(m / 60)} h ${rest} min` : `${m / 60} h`;
  }
  const hours = Math.floor((m % 1440) / 60);
  return hours ? `${Math.floor(m / 1440)} d ${hours} h` : `${Math.floor(m / 1440)} d`;
}

/** "2 credit notes" */
export function creditNoteCount(n: number): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? "credit note" : "credit notes"}`;
}
