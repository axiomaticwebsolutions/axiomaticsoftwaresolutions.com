/**
 * Admin Overview read model (Admin Console.dc.html `overview()`, decisions.md Phase 6), shared by
 * GET /api/admin/overview, the /admin page and its client dashboard. Pure and client-safe: types, groupings and the
 * prototype's copy. Amounts are integer paise, excluding GST; times are ISO strings (UTC) with labels computed in IST.
 */
import { OrderStatus } from "@/generated/prisma/enums";
import { auditActionLabel } from "@/lib/admin/audit/model";
import { TONE_NAMES, type Tone } from "@/lib/design/tokens";
import { formatDateIST } from "@/lib/dates";
import { EXPIRING_DAYS, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { formatINR } from "@/lib/money";
import { RANGE_META, type BucketUnit, type RangeKey } from "./range";

export type PaymentStatusKey = "paid" | "pending" | "failed" | "refunded" | "canceled";

/**
 * "Orders by payment status" segments (prototype order and labels). Every order status belongs to one group: the
 * waiting states read as Pending and partial refunds as Refunded, as in the portal's order filters.
 */
export const PAYMENT_STATUS_GROUPS: readonly { key: PaymentStatusKey; label: string; statuses: readonly OrderStatus[] }[] = [
  { key: "paid", label: "Paid", statuses: [OrderStatus.PAID] },
  {
    key: "pending",
    label: "Pending",
    statuses: [OrderStatus.AWAITING_PAYMENT, OrderStatus.CONFIRMING, OrderStatus.PENDING, OrderStatus.REVIEW],
  },
  { key: "failed", label: "Failed", statuses: [OrderStatus.FAILED] },
  { key: "refunded", label: "Refunded", statuses: [OrderStatus.REFUNDED, OrderStatus.PARTIALLY_REFUNDED] },
  { key: "canceled", label: "Canceled", statuses: [OrderStatus.CANCELED] },
];

/** Orders that count as sales: paid, and partly refunded ones net of their processed refunds. */
export const REVENUE_ORDER_STATUSES = [OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED] as const;

/** NEEDS ATTENTION (prototype: pending, review, confirming; all time). */
export const ATTENTION_ORDER_STATUSES = [OrderStatus.PENDING, OrderStatus.REVIEW, OrderStatus.CONFIRMING] as const;

/** License health rows in prototype order (derived statuses, lib/licensing/status.ts). */
export const LICENSE_HEALTH_ROWS: readonly { key: DerivedLicenseStatus; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "expiring", label: `Expiring < ${EXPIRING_DAYS}d` },
  { key: "trial", label: "Trial" },
  { key: "expired", label: "Expired" },
  { key: "suspended", label: "Suspended" },
  { key: "revoked", label: "Revoked" },
];

/** "N expire in the next 30 days" window of the ACTIVE LICENSES card. */
export const EXPIRING_SOON_KPI_DAYS = 30;
/** Recent activity rows (prototype: latest 7 audit rows). */
export const RECENT_ACTIVITY_LIMIT = 7;

export type OverviewKpis = {
  revenue: { paise: number; previousPaise: number; deltaPct: number | null };
  paidOrders: { count: number; previousCount: number; avgPaise: number };
  needsAttention: number;
  activeLicenses: { count: number; expiringSoon: number };
  openTickets: { count: number; high: number; unassigned: number };
};

export type RevenueBar = { key: string; label: string; title: string; paise: number };

export type OverviewProductRow = { id: string; name: string; tone: Tone; orders: number; activeLicenses: number; revenuePaise: number };

export type OverviewAssignee = { id: string | null; name: string; count: number };

export type OverviewActivity = { id: string; actor: string; action: string; target: string; at: string; when: string };

export type OverviewData = {
  range: RangeKey;
  generatedAt: string;
  /** Business details are still placeholders (settings `business.sample`): the note says "Sample data". */
  sample: boolean;
  kpis: OverviewKpis;
  revenue: { totalPaise: number; peakPaise: number; unit: BucketUnit; bars: RevenueBar[]; ticks: string[] };
  /** Orders created in the range per group; groups without orders are left out (prototype). */
  paymentStatus: { key: PaymentStatusKey; label: string; count: number }[];
  /** WebhookDelivery rows received in the range. */
  webhooks: { fulfilled: number; duplicates: number; rejected: number };
  /** Sorted by revenue, highest first. */
  products: OverviewProductRow[];
  licenseHealth: { key: DerivedLicenseStatus; label: string; count: number }[];
  support: { waitingOnUs: number; waitingOnCustomer: number; highPriority: number; assignees: OverviewAssignee[] };
  /** Latest audit rows; null for roles without `audit.view` (the panel is hidden). */
  recentActivity: OverviewActivity[] | null;
};

/** A stored tone name (Product.tone, Category.tone), else `fallback`. */
export function toneOf(value: string | null | undefined, fallback: Tone = "lavender"): Tone {
  return value && (TONE_NAMES as string[]).includes(value) ? (value as Tone) : fallback;
}

// ---------- Copy and formatting (prototype wording) ----------

export const OVERVIEW_COPY = {
  rangeGroup: "Date range",
  exportSummary: "Export summary",
  revenue: "Revenue",
  paymentStatus: "Orders by payment status",
  products: "Product performance",
  licenseHealth: "License health",
  support: "Support workload",
  activity: "Recent activity",
  ordersLink: "Orders",
  renewalsLink: "Renewals",
  ticketsLink: "Tickets",
  auditLink: "Audit log",
  noOrders: "No orders in this period.",
  noProducts: "No products yet.",
  noActivity: "No activity recorded yet.",
  unassigned: "Unassigned",
} as const;

/** Toolbar note (prototype "Sample data · amounts exclude GST unless noted"; "Sample data" only while it is). */
export function amountsNote(sample: boolean): string {
  return sample ? "Sample data \u00B7 amounts exclude GST unless noted" : "Amounts exclude GST unless noted";
}

/** Prototype m0(): whole rupees ("₹4,03,706"). */
export function rupeesWhole(paise: number): string {
  return formatINR(Math.round(paise / 100) * 100);
}

export type DeltaText = { direction: "up" | "down" | null; text: string };

/** REVENUE sub line: "▲ 12% vs previous 30 days" (arrow separate for screen readers), or why there is no change. */
export function revenueDelta(deltaPct: number | null, range: RangeKey): DeltaText {
  const previous = RANGE_META[range].previousLabel;
  if (deltaPct === null) return { direction: null, text: `No revenue in the ${previous}` };
  return { direction: deltaPct >= 0 ? "up" : "down", text: `${Math.abs(deltaPct)}% vs ${previous}` };
}

export function avgOrderText(avgPaise: number): string {
  return `Avg ${rupeesWhole(avgPaise)} per order`;
}

export function expiringSoonText(n: number): string {
  return `${n} ${n === 1 ? "expires" : "expire"} in the next ${EXPIRING_SOON_KPI_DAYS} days`;
}

export function openTicketsText(high: number, unassigned: number): string {
  return `${high} high priority \u00B7 ${unassigned} unassigned`;
}

const PER_UNIT: Record<BucketUnit, string> = { day: "day", week: "week", month: "month" };

/** Chart description (prototype aria-label). */
export function revenueChartLabel(range: RangeKey, totalPaise: number, peakPaise: number, unit: BucketUnit): string {
  return `Revenue over the last ${RANGE_META[range].label}, total ${rupeesWhole(totalPaise)}. Peak ${rupeesWhole(peakPaise)} per ${PER_UNIT[unit]}.`;
}

export function paymentStatusLabel(segments: readonly { label: string; count: number }[]): string {
  return segments.length === 0 ? OVERVIEW_COPY.noOrders : segments.map((s) => `${s.label} ${s.count}`).join(", ");
}

export function webhookLine(w: OverviewData["webhooks"]): string {
  return `Webhooks: ${w.fulfilled} fulfilled \u00B7 ${w.duplicates} duplicates ignored \u00B7 ${w.rejected} rejected (bad signature)`;
}

/** Bar length in percent of `max`, at least `min` percent for non-zero values (product bars: 3%). */
export function barPercent(value: number, max: number, min = 0): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, Math.max(min, (value / max) * 100));
}

/** Prototype rel(): "just now", "5m ago", "3h ago", "4d ago", then the IST date. */
export function relativeTime(at: Date, now: Date): string {
  const minutes = (now.getTime() - at.getTime()) / 60_000;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  const days = Math.round(minutes / 1440);
  return days < 30 ? `${days}d ago` : formatDateIST(at);
}

/**
 * The action as it reads after the actor ("Anita issued refund"): the first letter lowered (names inside the action
 * keep their case). Older webhook rows ("order.paid") read as their label ("webhook processed", as on the Audit log);
 * any other machine name becomes words ("foo.bar_baz" -> "foo bar baz").
 */
export function auditActionText(action: string): string {
  const label = auditActionLabel(action);
  const text = /^[a-z0-9]+(?:[._][a-z0-9]+)+$/.test(label) ? label.replace(/[._]+/g, " ") : label;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Assignee labels: first names (prototype), the full name where two people share a first name. */
export function assigneeNames(staff: readonly { id: string; name: string }[]): Map<string, string> {
  const first = (name: string) => name.trim().split(/\s+/)[0] || name.trim();
  const counts = new Map<string, number>();
  for (const s of staff) counts.set(first(s.name), (counts.get(first(s.name)) ?? 0) + 1);
  return new Map(staff.map((s) => [s.id, (counts.get(first(s.name)) ?? 0) > 1 ? s.name.trim() : first(s.name)]));
}
