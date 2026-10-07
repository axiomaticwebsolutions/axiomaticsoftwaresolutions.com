/**
 * Admin Customers module (Admin Console.dc.html `mods.customers`): list configuration, row and drawer shapes and the
 * prototype copy. Rows are business accounts (the customer workspace) shown through their first active Owner, like the
 * prototype's person-first rows. Pure and client-safe; the server side is ./queries.ts (reads) and ./actions.ts.
 */
import type { MemberStatus, TeamRole } from "@/generated/prisma/enums";
import type { ListQuerySpec } from "@/lib/admin/list-query";
import type { DerivedLicenseStatus } from "@/lib/licensing/status";
import { defineListState } from "@/lib/url-state";
import { INDIAN_STATES } from "@/lib/validation/states";
import { ADMIN_LIST_PAGE_SIZE, ADMIN_PAGE_SIZES, type AdminListQuery } from "@/lib/admin/licenses/list-state";

export const CUSTOMER_SORTS = ["name", "business", "state", "licenses", "orders", "ltv", "lastOrder"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export const CUSTOMER_GST_FILTERS = ["yes", "no"] as const;
export type CustomerFilter = "gst" | "state";
export type CustomerListQuery = AdminListQuery<CustomerFilter, CustomerSort>;

/** Prototype default: lifetime value, highest first. */
export const CUSTOMER_DEFAULT_SORT = { id: "ltv", desc: true } as const satisfies { id: CustomerSort; desc: boolean };

/** URL state of /admin/customers (?q=&filter[gst]=&filter[state]=&sort=-ltv&page=). */
export const CUSTOMERS_LIST = defineListState({
  filterStyle: "bracket",
  filters: { gst: { values: CUSTOMER_GST_FILTERS }, state: { values: INDIAN_STATES } },
  sortable: CUSTOMER_SORTS,
  defaultSort: CUSTOMER_DEFAULT_SORT,
  pageSize: ADMIN_LIST_PAGE_SIZE,
  pageSizes: ADMIN_PAGE_SIZES,
});

/** parseListQuery() spec of GET /api/admin/customers and its CSV export. */
const CUSTOMER_LIST_SPEC_FILTERS = { gst: CUSTOMER_GST_FILTERS, state: INDIAN_STATES } as const;

export const CUSTOMER_LIST_SPEC: ListQuerySpec<typeof CUSTOMER_LIST_SPEC_FILTERS, CustomerSort> = {
  filters: CUSTOMER_LIST_SPEC_FILTERS,
  sortable: CUSTOMER_SORTS,
  defaultSort: "-ltv",
};

export const CUSTOMER_GST_OPTIONS = [
  { value: "all", label: "All" },
  { value: "yes", label: "Registered" },
  { value: "no", label: "Unregistered" },
] as const;

export const CUSTOMERS_SEARCH_PLACEHOLDER = "Search name, email, business or GSTIN";

/** Email badge of the primary contact (prototype EMAIL column). */
export function emailBadge(verified: boolean | null): { label: string; tone: "sage" | "peach" | "slate" } {
  if (verified === null) return { label: "No owner", tone: "slate" };
  return verified ? { label: "Verified", tone: "sage" } : { label: "Unverified", tone: "peach" };
}

/** One row of the customers table (dates as ISO strings, money in paise). */
export type AdminCustomerRow = {
  /** BusinessAccount id. */
  id: string;
  legalName: string;
  gstin: string | null;
  state: string | null;
  /** First active Owner (null for an account without one). */
  ownerName: string | null;
  ownerEmail: string | null;
  ownerVerified: boolean | null;
  /** Active, expiring and trial licenses (prototype custStats().lics). */
  activeLicenses: number;
  /** Paid orders (PAID, partly refunded or refunded). */
  orders: number;
  /** PAID orders in full plus partly refunded ones net of processed refunds, incl. GST (the portal's spend rule). */
  lifetimeValuePaise: number;
  lastOrderAt: string | null;
};

export type AdminCustomerMember = {
  userId: string;
  name: string;
  email: string;
  role: TeamRole;
  status: MemberStatus;
  verified: boolean;
  /** Can sign in with a password (placeholder invitees and sample users cannot). */
  hasPassword: boolean;
};

export type AdminCustomerLicense = {
  id: string;
  productName: string;
  planName: string;
  status: DerivedLicenseStatus;
  expiresAt: string | null;
};

export type AdminCustomerOrder = { id: string; totalPaise: number; status: string; createdAt: string; lines: string };
export type AdminCustomerTicket = { id: string; subject: string; status: string; updatedAt: string };

export type AdminCustomerDetail = {
  id: string;
  legalName: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pin: string | null;
  createdAt: string;
  owner: (AdminCustomerMember & { phone: string | null }) | null;
  members: AdminCustomerMember[];
  lifetimeValuePaise: number;
  ordersCount: number;
  lastOrderAt: string | null;
  licenses: AdminCustomerLicense[];
  licensesTotal: number;
  orders: AdminCustomerOrder[];
  ordersTotal: number;
  tickets: AdminCustomerTicket[];
  ticketsTotal: number;
};

export const TEAM_ROLE_SHORT: Record<TeamRole, string> = {
  OWNER: "Owner",
  BILLING: "Billing admin",
  TECHNICAL: "Technical contact",
  VIEWER: "Viewer",
};

/** Prototype copy (drawer actions and toasts; the mock "queued (mock)" toasts become real results). */
export const CUSTOMER_COPY = {
  resendVerification: "Resend verification",
  sendPasswordReset: "Send password reset",
  verificationSent: (email: string) => `Verification code sent to ${email}`,
  resetSent: (email: string) => `Password reset link sent to ${email}`,
  emailNotSent: "We couldn\u2019t send the email. Try again in a few minutes.",
  alreadyVerified: "Email already verified",
  noPassword: "Hasn\u2019t set a password yet",
  noOwner: "This account has no active owner",
  licensesEmpty: "No licenses.",
  ordersEmpty: "No orders.",
  ticketsEmpty: "No tickets.",
} as const;

/** "Lucknow, Uttar Pradesh" (prototype Location field). */
export function locationLabel(city: string | null, state: string | null): string {
  return [city, state].filter((part): part is string => !!part && part.trim() !== "").join(", ");
}

/** Admin URL of a customer drawer. */
export function adminCustomerHref(id: string): string {
  return `/admin/customers?id=${encodeURIComponent(id)}`;
}
