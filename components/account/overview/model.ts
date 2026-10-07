/**
 * Overview view model (Customer Portal.dc.html vOverview): KPI cards, alert extras, device-slot segments, the renewal
 * timeline's text alternative, recent-activity rows and the copy around them. Pure and client-safe; the data comes
 * from getAccountOverview() (lib/portal/overview.ts), whose types are imported as types only.
 */
import { ICON_PATHS, type IconName } from "@/components/icons/registry";
import { licensePath, PORTAL_PATHS, relativeTime } from "@/components/account/portal-nav";
import { formatDateIST, formatDateTimeIST } from "@/lib/dates";
import type { Tone } from "@/lib/design/tokens";
import { formatINR } from "@/lib/money";
import type {
  OverviewAlert,
  OverviewKpis,
  RecentActivityRow,
  RenewalTimeline,
  UtilizationRow,
} from "@/lib/portal/overview";
import type { RenewalOption } from "@/lib/licensing/account";

export const OVERVIEW_COPY = {
  title: "Overview",
  description: (business: string) => `${business} \u00b7 licenses, devices, renewals and spend at a glance.`,
  raiseTicket: "Raise a ticket",
  downloadSoftware: "Download software",
  utilization: "Device slot utilization",
  allDevices: "All devices",
  noUtilization: "No active licenses.",
  renewals: "Renewals \u00b7 next 12 months",
  licenses: "Licenses",
  noRenewals: "Nothing due in the next 12 months.",
  renew: "Renew",
  spend: "Spend by product",
  spendCaption: "All time \u00b7 incl. GST \u00b7 excl. refunds",
  /** New: an account without paid orders (the prototype always had some). */
  noSpend: "No purchases yet.",
  activity: "Recent activity",
  activityLog: "Activity log",
  /** New: an account without activity in the retention window. */
  noActivity: "No activity yet.",
} as const;

// ---------- Small text helpers ----------

/** "1 day", "41 days" (Phase 3 grammar fix of the prototype's "{n} days"). */
export function daysText(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function plural(n: number, one: string, other = `${one}s`): string {
  return `${n} ${n === 1 ? one : other}`;
}

/** Lower-cases the first letter, as the prototype's activity rows do ("Priya Sharma opened ticket"). */
export function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** A Material Symbols name from data when the registry has it, else `fallback`. */
export function iconOr(name: string | null | undefined, fallback: IconName): IconName {
  return name && Object.hasOwn(ICON_PATHS, name) ? (name as IconName) : fallback;
}

// ---------- KPIs ----------

export type KpiCard = {
  key: "licenses" | "deviceSlots" | "spend" | "nextRenewal";
  label: string;
  icon: IconName;
  tone: Tone;
  value: string;
  sub: string;
  href: string;
};

/** The four KPI link cards, in prototype order and wording. */
export function kpiCards(kpis: OverviewKpis): KpiCard[] {
  const { licenses, deviceSlots, spend, nextRenewal } = kpis;
  return [
    {
      key: "licenses",
      label: "Active licenses",
      icon: "key",
      tone: "lavender",
      value: `${licenses.active} of ${licenses.total}`,
      sub: `${licenses.inactive} expired or revoked`,
      href: PORTAL_PATHS.licenses,
    },
    {
      key: "deviceSlots",
      label: "Device slots",
      icon: "computer",
      tone: "blue",
      value: `${deviceSlots.used} / ${deviceSlots.slots}`,
      sub:
        deviceSlots.pct === null
          ? "No active slots"
          : `${deviceSlots.pct}% in use across ${plural(deviceSlots.licenses, "license")}`,
      href: PORTAL_PATHS.devices,
    },
    {
      key: "spend",
      label: "Spend \u00b7 12 months",
      icon: "payments",
      tone: "sage",
      value: formatINR(spend.last12MonthsPaise),
      sub: `This FY ${formatINR(spend.thisFyPaise)} \u00b7 ${formatINR(spend.allTimePaise)} all time`,
      href: PORTAL_PATHS.orders,
    },
    {
      key: "nextRenewal",
      label: "Next renewal",
      icon: "event_upcoming",
      tone: "peach",
      value: nextRenewal ? daysText(nextRenewal.days) : "\u2014",
      sub: nextRenewal
        ? `${nextRenewal.productShortName} \u00b7 ${formatDateIST(new Date(nextRenewal.expiresAt))}`
        : "Nothing due",
      href: nextRenewal ? licensePath(nextRenewal.licenseId) : PORTAL_PATHS.licenses,
    },
  ];
}

// ---------- Alerts ----------

/**
 * New copy: the other cases behind a "one alert per kind" banner (F3 counts them in `more`), e.g. "2 more licenses
 * also end within 60 days." Null when the alert names the only case.
 */
export function alertMoreText(alert: Pick<OverviewAlert, "kind" | "more">): string | null {
  const n = alert.more;
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (alert.kind) {
    case "expiring":
      return `${plural(n, "more license")} also ${n === 1 ? "ends" : "end"} within 60 days.`;
    case "expired":
      return `${plural(n, "more license")} also ended recently.`;
    case "updates_ended":
      return `${plural(n, "more license")} also ${n === 1 ? "needs" : "need"} maintenance for newer versions.`;
    case "ticket_waiting":
      return `${plural(n, "more ticket")} also ${n === 1 ? "needs" : "need"} your reply.`;
    case "device_limit":
      return `${plural(n, "more license")} also ${n === 1 ? "has" : "have"} no free device slots.`;
    default:
      return null;
  }
}

/** How an alert's call to action behaves: add a renewal to the cart, or follow a link. */
export type AlertAction =
  | { type: "renewal"; label: string; licenseId: string; renewal: RenewalOption; href: string }
  | { type: "link"; label: string; href: string };

export function alertAction(alert: Pick<OverviewAlert, "cta" | "licenseId">): AlertAction {
  const { cta, licenseId } = alert;
  if (cta.renewal && licenseId) {
    return { type: "renewal", label: cta.label, licenseId, renewal: cta.renewal, href: cta.href };
  }
  return { type: "link", label: cta.label, href: cta.href };
}

// ---------- Device slot utilization ----------

/** Above this many slots a license gets one proportional bar instead of a cell per slot (keeps cells readable). */
export const MAX_SLOT_CELLS = 40;

export type SlotCell = "used" | "full" | "free";

export type SlotBar =
  | { mode: "cells"; cells: SlotCell[] }
  | { mode: "bar"; pct: number; full: boolean };

/** Prototype segments: one cell per slot; used cells are primary, or all orange when every slot is taken. */
export function slotBar(row: Pick<UtilizationRow, "used" | "limit" | "full">, maxCells = MAX_SLOT_CELLS): SlotBar {
  const limit = Math.max(0, Math.trunc(row.limit));
  const used = Math.max(0, Math.min(Math.trunc(row.used), limit));
  const full = row.full || (limit > 0 && row.used >= limit);
  if (limit > maxCells) {
    return { mode: "bar", pct: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0, full };
  }
  return { mode: "cells", cells: Array.from({ length: limit }, (_, i) => (i < used ? (full ? "full" : "used") : "free")) };
}

/** "2 of 3" (visible) and the text alternative of the segmented bar. */
export function slotLabel(row: Pick<UtilizationRow, "used" | "limit">): string {
  return `${row.used} of ${row.limit}`;
}

export function slotAriaLabel(row: Pick<UtilizationRow, "used" | "limit">): string {
  return `${row.used} of ${plural(row.limit, "device slot")} used`;
}

// ---------- Renewals timeline ----------

type RenewalItem = RenewalTimeline["items"][number];

/** "Ends 17 Nov 2026 · 41 days" */
export function renewalWhen(item: Pick<RenewalItem, "expiresAt" | "days">): string {
  return `Ends ${formatDateIST(new Date(item.expiresAt))} \u00b7 ${daysText(item.days)}`;
}

/** "₹4,999 + GST" (renewal price excluding GST, as the prototype). */
export function renewalPrice(renewal: Pick<RenewalOption, "pricePaise">): string {
  return `${formatINR(renewal.pricePaise)} + GST`;
}

/** Dot tooltip: "LIC-24017 · 17 Nov 2026". */
export function timelineDotTitle(item: Pick<RenewalItem, "licenseId" | "expiresAt">): string {
  return `${item.licenseId} \u00b7 ${formatDateIST(new Date(item.expiresAt))}`;
}

/** Text alternative of the 12-month track (the list under it repeats the details). */
export function timelineAriaLabel(items: readonly Pick<RenewalItem, "licenseId" | "expiresAt">[]): string {
  if (items.length === 0) return "Renewal timeline: nothing due in the next 12 months.";
  const parts = items.map((i) => `${i.licenseId} on ${formatDateIST(new Date(i.expiresAt))}`);
  return `Renewal timeline for the next 12 months: ${parts.join(", ")}.`;
}

/** Clamped dot position (the API already clamps to 2-98). */
export function dotLeft(positionPct: number): string {
  const pct = Number.isFinite(positionPct) ? Math.min(98, Math.max(2, positionPct)) : 2;
  return `${pct}%`;
}

// ---------- Recent activity ----------

const ACTIVITY_VISUALS: Readonly<Record<string, { icon: IconName; tone: Tone }>> = {
  license: { icon: "key", tone: "lavender" },
  ticket: { icon: "support_agent", tone: "blue" },
  team: { icon: "group", tone: "sage" },
  billing: { icon: "receipt_long", tone: "peach" },
  download: { icon: "download", tone: "blue" },
  security: { icon: "shield", tone: "pink" },
};

/** Prototype actRow() icon tiles per activity kind; anything else is a lavender history icon. */
export function activityVisual(kind: string): { icon: IconName; tone: Tone } {
  return Object.hasOwn(ACTIVITY_VISUALS, kind) ? (ACTIVITY_VISUALS[kind] as { icon: IconName; tone: Tone }) : { icon: "history", tone: "lavender" };
}

export type ActivityLine = {
  id: string;
  actor: string;
  action: string;
  target: string;
  when: string;
  /** Full IST date and time for the tooltip. */
  at: string;
  dateTime: string;
  icon: IconName;
  tone: Tone;
};

export function activityLine(row: RecentActivityRow, now: Date): ActivityLine {
  const at = new Date(row.at);
  const visual = activityVisual(row.kind);
  return {
    id: row.id,
    actor: row.actorName,
    action: lowerFirst(row.action),
    target: row.target,
    when: relativeTime(at, now),
    at: formatDateTimeIST(at),
    dateTime: at.toISOString(),
    icon: visual.icon,
    tone: visual.tone,
  };
}

/** "+3 more licenses" under a capped list. */
export function moreText(n: number, one: string): string | null {
  return n > 0 ? `+${plural(n, `more ${one}`)}` : null;
}
