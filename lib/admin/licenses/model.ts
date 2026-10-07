/**
 * Admin Licenses module (Admin Console.dc.html `mods.licenses` + `licDetail`): list configuration, row and drawer
 * shapes, and the prototype copy for every license action. Pure and client-safe; the server side lives in
 * ./queries.ts (reads) and ./actions.ts (changes).
 */
import type { PlanType } from "@/generated/prisma/enums";
import type { ListQuerySpec } from "@/lib/admin/list-query";
import { DERIVED_LICENSE_STATUSES, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { addDays, formatDateIST, istParts, maxDate, MONTHS_SHORT } from "@/lib/dates";
import { defineListState } from "@/lib/url-state";
import { ADMIN_LIST_PAGE_SIZE, ADMIN_PAGE_SIZES, productFilterParam, type AdminListQuery } from "./list-state";

export const LICENSE_SORTS = ["id", "customer", "status", "expires", "devices", "issued"] as const;
export type LicenseSort = (typeof LICENSE_SORTS)[number];

/** Devices filter: at the device limit, or no active device at all. */
export const LICENSE_DEVICE_FILTERS = ["full", "none"] as const;
export type LicenseDeviceFilter = (typeof LICENSE_DEVICE_FILTERS)[number];

export type LicenseFilter = "status" | "product" | "devices";
export type LicenseListQuery = AdminListQuery<LicenseFilter, LicenseSort>;

export const LICENSE_DEFAULT_SORT = { id: "issued", desc: true } as const satisfies { id: LicenseSort; desc: boolean };

/** URL state of /admin/licenses (?q=&filter[status]=&filter[product]=&filter[devices]=&sort=-issued&page=). */
export const LICENSES_LIST = defineListState({
  filterStyle: "bracket",
  filters: {
    status: { values: DERIVED_LICENSE_STATUSES },
    product: {},
    devices: { values: LICENSE_DEVICE_FILTERS },
  },
  sortable: LICENSE_SORTS,
  defaultSort: LICENSE_DEFAULT_SORT,
  pageSize: ADMIN_LIST_PAGE_SIZE,
  pageSizes: ADMIN_PAGE_SIZES,
});

/** parseListQuery() spec of GET /api/admin/licenses and its CSV export. */
const LICENSE_LIST_SPEC_FILTERS = { status: DERIVED_LICENSE_STATUSES, product: productFilterParam, devices: LICENSE_DEVICE_FILTERS } as const;

export const LICENSE_LIST_SPEC: ListQuerySpec<typeof LICENSE_LIST_SPEC_FILTERS, LicenseSort> = {
  filters: LICENSE_LIST_SPEC_FILTERS,
  sortable: LICENSE_SORTS,
  defaultSort: "-issued",
};

export const LICENSE_STATUS_OPTIONS: readonly { value: DerivedLicenseStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "expiring", label: "Expiring" },
  { value: "expired", label: "Expired" },
  { value: "trial", label: "Trial" },
  { value: "suspended", label: "Suspended" },
  { value: "revoked", label: "Revoked" },
];

export const LICENSE_DEVICE_OPTIONS: readonly { value: LicenseDeviceFilter | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "full", label: "At limit" },
  { value: "none", label: "None activated" },
];

export const LICENSES_SEARCH_PLACEHOLDER = "Search license ID, last 4 of key, email or device";

/** One row of the licenses table (dates as ISO strings). */
export type AdminLicenseRow = {
  id: string;
  productId: string;
  productName: string;
  productShortName: string;
  planName: string;
  /** "MED-••••-••••-••••-K8NM": the console never holds more than the last four characters. */
  keyMasked: string;
  status: DerivedLicenseStatus;
  /** Business (or the person's name, or the guest order's email). */
  customerName: string;
  customerEmail: string | null;
  accountId: string | null;
  expiresAt: string | null;
  issuedAt: string;
  deviceLimit: number;
  devicesUsed: number;
};

export type AdminLicenseStats = { active: number; expiring: number; devicesInUse: number; suspendedOrRevoked: number };

export type AdminProductOption = { id: string; name: string; shortName: string };

export type AdminLicenseDevice = {
  id: string;
  name: string;
  os: string;
  appVersion: string | null;
  /** First 10 characters of the device fingerprint hash (enough to tell devices apart). */
  fingerprintShort: string;
  activatedAt: string;
  lastSeenAt: string;
  deactivatedAt: string | null;
  /** customer | device | staff | system */
  deactivatedBy: string | null;
  active: boolean;
};

/** One History row of the drawer: a license event, or a staff action from the audit log with its reason. */
export type AdminLicenseHistoryEntry = {
  id: string;
  /** "Suspended license", "License issued", "Activated". */
  label: string;
  /** "Sneha Patil · Customer asked to pause", "System", "Order AX-10289". */
  by: string;
  at: string;
};

export type AdminLicenseOrder = { id: string; kind: string; status: string; totalPaise: number; createdAt: string };

export type AdminLicenseDetail = {
  id: string;
  productId: string;
  productName: string;
  productShortName: string;
  planId: string;
  planName: string;
  planType: PlanType;
  keyMasked: string;
  status: DerivedLicenseStatus;
  storedStatus: "ACTIVE" | "TRIAL" | "SUSPENDED" | "REVOKED";
  accountId: string | null;
  businessName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  orderId: string | null;
  issuedAt: string;
  expiresAt: string | null;
  updatesUntil: string;
  deviceLimit: number;
  devicesUsed: number;
  selfServiceResetsUsed: number;
  selfServiceResetsPerYear: number;
  revokedAt: string | null;
  revokedReason: string | null;
  /** Plan price x terminals for per-unit plans, excluding GST (Renewals "Renewal value"). */
  renewalValuePaise: number;
  /** "Order AX-10289", "Trial" or "Issued by staff" (prototype Order field). */
  origin: string;
  devices: AdminLicenseDevice[];
  devicesTotal: number;
  history: AdminLicenseHistoryEntry[];
  orders: AdminLicenseOrder[];
};

/** Plan types staff can issue by hand (add-ons and maintenance need a target license). */
export const MANUAL_ISSUE_PLAN_TYPES = ["ONE_TIME", "ANNUAL", "SUBSCRIPTION", "TRIAL"] as const satisfies readonly PlanType[];

export type ManualIssuePlanOption = {
  id: string;
  name: string;
  type: PlanType;
  productId: string;
  productName: string;
  perUnit: boolean;
  maxQty: number | null;
};

export type ManualIssueResult = {
  id: string;
  keyMasked: string;
  productName: string;
  planName: string;
  /** Who got the key delivery email (null when the account has no reachable owner). */
  emailedTo: string | null;
};

/** Days added by the drawer's "Extend 30 days" (the API takes 1-365). */
export const EXTEND_DEFAULT_DAYS = 30;
export const EXTEND_MAX_DAYS = 365;
export const BULK_MAX_LICENSES = 100;

export type BulkLicenseResult = { updated: string[]; skipped: { id: string; reason: string }[] };

/** Prototype dialog copy (licDetail ask() calls). */
export const LICENSE_COPY = {
  suspend:
    "Installed copies will fail their next validation check (within the 7-day offline grace period). You can reinstate later.",
  reinstate: "Activations and validation resume immediately.",
  extend: (days: number) => `Moves the end date and updates-until date forward ${days} days at no charge.`,
  resetDevices: (n: number) =>
    `Deactivates all ${n} ${n === 1 ? "device" : "devices"} so the customer can activate fresh. Use when hardware failed.`,
  revoke: "The key stops working on every device and can\u2019t be reinstated. Use for fraud or refunds only.",
  deactivateDevice: (licenseId: string) =>
    `Frees one slot on ${licenseId}. Doesn\u2019t count toward the customer\u2019s self-service limit.`,
  bulkExtend: "Revoked licenses are skipped.",
  bulkSuspend: "Copies stop validating after the offline grace period.",
} as const;

/** Toasts (prototype). */
export const LICENSE_TOASTS = {
  suspend: "License suspended",
  reinstate: "License reinstated",
  extend: (days: number) => `Extended by ${days} days`,
  resetDevices: "Devices reset",
  revoke: "License revoked",
  deactivateDevice: "Device deactivated",
  bulkExtend: "Licenses extended",
  bulkSuspend: "Licenses suspended",
} as const;

/** "1 / 3" with the bar fill (prototype DEVICES column): orange at the limit, else primary. */
export function deviceUsage(used: number, limit: number): { label: string; pct: number; full: boolean } {
  const full = used >= limit;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : used > 0 ? 100 : 0;
  return { label: `${used} / ${limit}`, pct, full };
}

/** Renewal price of a license: plan price, times the terminals for per-unit plans (excluding GST). */
export function renewalValuePaise(plan: { pricePaise: number; perUnit: string | null }, deviceLimit: number): number {
  return plan.pricePaise * (plan.perUnit ? Math.max(1, deviceLimit) : 1);
}

/** Admin URL of a license drawer (Customers links here; the Licenses page opens the drawer from ?id=). */
export function adminLicenseHref(id: string): string {
  return `/admin/licenses?id=${encodeURIComponent(id)}`;
}

/**
 * Terms after "Extend N days" (prototype): the end date and the updates-until date each move N days on from the later
 * of now and their current value; a perpetual license (no end date) keeps none.
 */
export function extendedTerms(
  license: { expiresAt: Date | null; updatesUntil: Date },
  days: number,
  now: Date,
): { expiresAt: Date | null; updatesUntil: Date } {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError("Extend by a positive number of days");
  return {
    expiresAt: license.expiresAt ? addDays(maxDate(license.expiresAt, now), days) : null,
    updatesUntil: addDays(maxDate(license.updatesUntil, now), days),
  };
}

/** Audit label of an extension (prototype vocabulary "Extended license +30 days"). */
export function extendAuditAction(days: number): string {
  return `Extended license +${days} ${days === 1 ? "day" : "days"}`;
}

/** "13 Sep, 2:24 am" in IST (prototype fdt: drawer history and device rows). */
export function shortDateTimeIST(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const p = istParts(d);
  const hour = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${p.day} ${MONTHS_SHORT[p.month - 1]}, ${hour}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "am" : "pm"}`;
}

/** "just now", "5m ago", "3h ago", "27d ago", then the date (prototype rel()). */
export function relativeAgo(value: string | Date, now: Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const minutes = (now.getTime() - d.getTime()) / 60_000;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  const days = Math.round(minutes / 1440);
  return days < 30 ? `${days}d ago` : formatDateIST(d);
}
