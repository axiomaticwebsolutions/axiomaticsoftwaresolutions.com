/**
 * Admin Renewals module (Admin Console.dc.html `mods.renewals`): licenses ending in the next 60 days or ended in the
 * last 30 (non-revoked, not trials, with an end date). List configuration, row shape, the DAYS cell rule, the reminder
 * template choice and copy. Pure and client-safe; server side in ./queries.ts and ./remind.ts.
 */
import type { PlanType } from "@/generated/prisma/enums";
import type { ListQuerySpec } from "@/lib/admin/list-query";
import { DAY_MS, istParts } from "@/lib/dates";
import type { DerivedLicenseStatus } from "@/lib/licensing/status";
import { defineListState } from "@/lib/url-state";
import { ADMIN_LIST_PAGE_SIZE, ADMIN_PAGE_SIZES, type AdminListQuery } from "@/lib/admin/licenses/list-state";

/** Row set: ends within this many days ahead... */
export const RENEWAL_AHEAD_DAYS = 60;
/** ...or ended within this many days. */
export const RENEWAL_LAPSED_DAYS = 30;
/** "Due <= 30 days" / "Next 30 days" boundary. */
export const RENEWAL_SOON_DAYS = 30;
/** renewal_7 instead of renewal_30 from this many days left. */
export const RENEWAL_LAST_WEEK_DAYS = 7;
export const REMIND_MAX_LICENSES = 100;

export const RENEWAL_WINDOWS = ["30", "60", "lapsed"] as const;
export type RenewalWindow = (typeof RENEWAL_WINDOWS)[number];

export const RENEWAL_SORTS = ["id", "customer", "ends", "days", "value"] as const;
export type RenewalSort = (typeof RENEWAL_SORTS)[number];
export type RenewalFilter = "window";
export type RenewalListQuery = AdminListQuery<RenewalFilter, RenewalSort>;

export const RENEWAL_DEFAULT_SORT = { id: "ends", desc: false } as const satisfies { id: RenewalSort; desc: boolean };

/** URL state of /admin/renewals (?q=&filter[window]=&sort=ends&page=). */
export const RENEWALS_LIST = defineListState({
  filterStyle: "bracket",
  filters: { window: { values: RENEWAL_WINDOWS } },
  sortable: RENEWAL_SORTS,
  defaultSort: RENEWAL_DEFAULT_SORT,
  pageSize: ADMIN_LIST_PAGE_SIZE,
  pageSizes: ADMIN_PAGE_SIZES,
});

/** parseListQuery() spec of GET /api/admin/renewals and its CSV export. */
const RENEWAL_LIST_SPEC_FILTERS = { window: RENEWAL_WINDOWS } as const;

export const RENEWAL_LIST_SPEC: ListQuerySpec<typeof RENEWAL_LIST_SPEC_FILTERS, RenewalSort> = {
  filters: RENEWAL_LIST_SPEC_FILTERS,
  sortable: RENEWAL_SORTS,
  defaultSort: "ends",
};

export const RENEWAL_WINDOW_OPTIONS = [
  { value: "all", label: "All" },
  { value: "30", label: "Next 30 days" },
  { value: "60", label: "31\u201360 days" },
  { value: "lapsed", label: "Lapsed" },
] as const;

export const RENEWALS_SEARCH_PLACEHOLDER = "Search license ID, customer or email";

export type AdminRenewalRow = {
  id: string;
  productId: string;
  productName: string;
  productShortName: string;
  planName: string;
  planType: PlanType;
  customerName: string;
  customerEmail: string | null;
  accountId: string | null;
  status: DerivedLicenseStatus;
  expiresAt: string;
  /** Prototype DAYS: whole days left, rounded up; negative once lapsed. */
  daysLeft: number;
  /** Plan price x terminals for per-unit plans, excluding GST. */
  renewalValuePaise: number;
  /** Newest renewal reminder queued for this license (manual or automatic), if any. */
  lastReminderAt: string | null;
};

export type AdminRenewalStats = { dueSoon: number; dueLater: number; lapsed: number; valuePaise: number };

/** Prototype DAYS: ceil((ends - now) / 1 day). */
export function renewalDaysLeft(expiresAt: Date, now: Date): number {
  return Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
}

/** DAYS cell: "-12 (lapsed)" in red, <= 30 in amber, else plain (prototype colours). */
export function renewalDaysCell(days: number): { label: string; tone: "danger" | "warn" | "default" } {
  if (days < 0) return { label: `${days} (lapsed)`, tone: "danger" };
  return { label: String(days), tone: days <= RENEWAL_SOON_DAYS ? "warn" : "default" };
}

export type ReminderTemplateId = "renewal_30" | "renewal_7" | "license_expired";

/** Which reminder a manual "Send reminder now" sends: ended -> license_expired, last week -> renewal_7, else renewal_30. */
export function reminderTemplateFor(expiresAt: Date, now: Date): ReminderTemplateId {
  if (expiresAt.getTime() <= now.getTime()) return "license_expired";
  return renewalDaysLeft(expiresAt, now) <= RENEWAL_LAST_WEEK_DAYS ? "renewal_7" : "renewal_30";
}

/** Is the license in the Renewals row set (ends within 60 days ahead, or ended within 30)? */
export function inRenewalWindow(expiresAt: Date | null, now: Date): boolean {
  if (!expiresAt) return false;
  const t = expiresAt.getTime();
  return t > now.getTime() - RENEWAL_LAPSED_DAYS * DAY_MS && t < now.getTime() + RENEWAL_AHEAD_DAYS * DAY_MS;
}

/** "2026-10-07" in IST: reminders are deduplicated per license, template and IST day. */
export function istDayKey(now: Date): string {
  const p = istParts(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** OutboxEmail.dedupeKey prefix of every reminder of a license ("renewal:LIC-24017:"). */
export function renewalReminderPrefix(licenseId: string): string {
  return `renewal:${licenseId}:`;
}

/** Prefix shared by the recipients of one license + template + day ("renewal:LIC-24017:renewal_30:2026-10-07:"). */
export function renewalReminderDayPrefix(licenseId: string, templateId: ReminderTemplateId, now: Date): string {
  return `${renewalReminderPrefix(licenseId)}${templateId}:${istDayKey(now)}:`;
}

export type RemindResult = {
  queued: { id: string; templateId: ReminderTemplateId; recipients: number }[];
  skipped: { id: string; reason: string }[];
};

export const RENEWAL_COPY = {
  remind: "Send reminder now",
  remindLabel: (n: number) => `Send renewal reminders for ${n} ${n === 1 ? "license" : "licenses"}`,
  notSent: "Not sent",
  /** Toast after a send (prototype "{n} reminders queued (mock)"). */
  queued: (result: RemindResult) => {
    const n = result.queued.length;
    const parts = [`${n} ${n === 1 ? "reminder" : "reminders"} queued`];
    if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
    return parts.join(" \u00B7 ");
  },
  skippedReasons: {
    notFound: "Not found",
    revoked: "Revoked",
    trial: "Trial license",
    noEndDate: "No end date",
    outsideWindow: "Not due for renewal",
    alreadySent: "Already sent today",
    noRecipient: "No one to email (renewal emails turned off)",
  },
} as const;
