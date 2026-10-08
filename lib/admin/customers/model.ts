/**
 * Admin Customers module (Admin Console.dc.html `mods.customers`): list configuration, row and drawer shapes and the
 * prototype copy. Rows are business accounts (the customer workspace) shown through their first active Owner, like the
 * prototype's person-first rows. Pure and client-safe; the server side is ./queries.ts (reads) and ./actions.ts.
 */
import type { MemberStatus, PlanType, TeamRole } from "@/generated/prisma/enums";
import type { ListQuerySpec } from "@/lib/admin/list-query";
import type { DerivedLicenseStatus } from "@/lib/licensing/status";
import { validateReason } from "@/lib/rbac";
import { defineListState } from "@/lib/url-state";
import { BILLING_ERRORS } from "@/lib/validation/billing";
import { isEmailAddress } from "@/lib/validation/contact";
import type { BillingDetails } from "@/lib/validation/portal";
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
  /** Staff created this person in Admin > Customers (User.createdByStaffId). */
  createdByStaff: boolean;
  /** An active customer member without a password: staff can create a set-password link for them. */
  canSetPassword: boolean;
};

export type AdminCustomerLicense = {
  id: string;
  /** For the order form (target licenses of renewals and add-ons). */
  productId: string;
  productName: string;
  planName: string;
  planType: PlanType;
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

// ---------- Admin records: create, edit, verify, set-password links (docs/admin-records-design.md PART A) ----------

/** Who changes an account in its activity log when staff do it (portal "Activity log"). */
export const STAFF_ACTIVITY_ACTOR = { id: null, name: "Axiomatic team" } as const;

/** Field messages of the customer forms that are not shared with the portal validation. */
export const CUSTOMER_FORM_ERRORS = {
  name: "Enter the person’s full name.",
  email: BILLING_ERRORS.email,
  nothingToUpdate: "Change a field before saving.",
  emailVerifiedWithoutChange: "Tick this only when you change the email.",
} as const;

/** Most order ids a guest-claim audit note lists before "and N more". */
const CLAIM_NOTE_MAX_IDS = 20;

/**
 * Audit note for the guest orders a staff-verified address moved into the account (create with "Email already
 * verified", an email change ticked verified, "Mark email as verified"): " · 2 guest orders moved to this account:
 * AX-10291, AX-10307". Empty when nothing moved.
 */
export function guestClaimNote(orderIds: readonly string[]): string {
  const n = orderIds.length;
  if (n === 0) return "";
  const listed = orderIds.slice(0, CLAIM_NOTE_MAX_IDS).join(", ");
  const more = n > CLAIM_NOTE_MAX_IDS ? ` and ${n - CLAIM_NOTE_MAX_IDS} more` : "";
  return ` · ${n} guest ${n === 1 ? "order" : "orders"} moved to this account: ${listed}${more}`;
}

/** Server refusals of the customer record actions (shown as they arrive). */
export const CUSTOMER_RECORD_MESSAGES = {
  noOwner: "This account has no active owner. Choose a member instead.",
  noOwnerToEdit: "This account has no active owner, so there’s no person to change.",
  notMember: "Choose a member of this account.",
  memberInvited: "This person hasn’t accepted their team invitation yet.",
  memberInvitedLink: "This person hasn’t accepted their team invitation yet. Ask the account owner to resend it.",
  notCustomer: "Staff accounts can’t be changed here.",
  hasPassword: "This person already has a password. Send a password reset instead.",
  emailTakenCustomer: "A customer with this email already exists.",
  emailTakenStaff: "This email belongs to a staff account.",
  emailTakenOther: "This email is already used by another account.",
  emailVerifiedWithoutChange: CUSTOMER_FORM_ERRORS.emailVerifiedWithoutChange,
} as const;

/** Console copy of the customer record actions (new copy; the prototype has none of these). */
export const CUSTOMER_RECORD_COPY = {
  newCustomer: "New customer",
  newSubtitle: "They get a link to set their own password.",
  details: "Details",
  person: "Person",
  business: "Business",
  name: "Full name",
  email: "Email",
  emailHint: "They sign in with this address.",
  mobile: "Mobile",
  mobileHint: "10-digit Indian mobile number.",
  legalName: "Business or legal name",
  legalNameHint: "Leave empty to use the person’s name.",
  legalNameEdit: "Business or legal name",
  gstin: "GSTIN",
  gstinHint: "Needs the state it’s registered in.",
  address: "Address",
  city: "City",
  state: "State",
  statePlaceholder: "Choose a state",
  pin: "PIN code",
  emailVerified: "Email already verified",
  emailVerifiedHint: "Tick only if you’ve confirmed they own this address. Guest purchases made with it move into this account.",
  reason: "Reason (saved to the audit log)",
  create: "Create customer",
  openCustomer: "Open customer",
  addAnother: "Add another",
  created: "Customer created",
  linkLabel: "Set-password link (shown once)",
  copyLink: "Copy link",
  copied: "Link copied",
  copyFailed: "Couldn’t copy the link. Select it and copy it instead.",
  linkSent: (name: string, date: string) => `Send this link to ${name} if they can’t find our email. It works once and expires on ${date}.`,
  linkNotSent: (name: string, date: string) => `We couldn’t email it, so send this link to ${name} yourself. It works once and expires on ${date}.`,
  linkWarning: "Anyone with this link can set the password. Share it only with the customer.",
  editTitle: "Edit details",
  editReadOnly: "Your role can’t edit customers.",
  personNote: "Name, email and mobile belong to the person and change in every account they’re in.",
  noOwnerNote: "This account has no active owner, so only the business details can change here.",
  newEmailVerified: "New email already verified",
  emailChangeWarning: (name: string) => `Changing the email signs ${name} out everywhere and stops their old links. We’ll tell the old address.`,
  save: "Save changes",
  updated: "Customer updated",
  noChanges: "No changes to save",
  updatedSignedOut: (n: number) => `Customer updated · signed out of ${n} ${n === 1 ? "session" : "sessions"}`,
  verifiedAlready: "Email already verified",
  noActiveOwner: "No active owner",
  verifyConsequence: (email: string, name: string, legalName: string) =>
    `Confirms that ${email} belongs to ${name}. Their pending verification code stops working, and guest purchases made with this email move into ${legalName}.`,
  verifyDone: "Email marked as verified",
  linkConsequence: (name: string, email: string) =>
    `Creates a link ${name} can use once to choose a password. It expires in 7 days and you’ll see it only once. We also email it to ${email}.`,
  linkDialogTitle: "Set-password link",
  close: "Close",
} as const;

type PersonFields = { name: string; phone: string | null; email: string };
type PersonPatch = { name?: string; phone?: string | null; email?: string };

const PERSON_KEYS = ["name", "phone", "email"] as const;
const BUSINESS_KEYS = ["legalName", "gstin", "address", "city", "state", "pin"] as const satisfies readonly (keyof BillingDetails)[];

/**
 * Names of the fields an edit changes (audit detail "Changed: name, phone, email, gstin"): person fields compared with
 * the owner (ignored without one), business fields with the merged details. Names only, never values.
 */
export function changedCustomerFields(
  person: PersonFields | null,
  business: BillingDetails,
  personPatch: PersonPatch,
  nextBusiness: BillingDetails,
): string[] {
  const out: string[] = [];
  if (person) {
    for (const key of PERSON_KEYS) {
      const value = personPatch[key];
      if (value !== undefined && value !== person[key]) out.push(key);
    }
  }
  for (const key of BUSINESS_KEYS) if (nextBusiness[key] !== business[key]) out.push(key);
  return out;
}

/** Names of the fields a new customer was created with (audit detail "fields: name, email, phone, gstin"). */
export function createdCustomerFields(input: { [K in "phone" | "legalName" | "gstin" | "address" | "city" | "state" | "pin"]?: string | null }): string[] {
  const optional = (["phone", "legalName", "gstin", "address", "city", "state", "pin"] as const).filter((key) => {
    const value = input[key];
    return value !== undefined && value !== null && value !== "";
  });
  return ["name", "email", ...optional];
}

/** "7 days", "30 minutes": how long a set-password link lasts (email copy). */
export function setPasswordExpiresText(ms: number): string {
  const DAY = 86_400_000;
  if (ms >= DAY && ms % DAY === 0) {
    const days = ms / DAY;
    return days === 1 ? "1 day" : `${days} days`;
  }
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** The form values of the customer edit card, as strings (empty = none). */
export type CustomerEditDraft = {
  name: string;
  email: string;
  phone: string;
  legalName: string;
  gstin: string;
  address: string;
  city: string;
  state: string;
  pin: string;
  emailVerified: boolean;
  reason: string;
};

/** A blank "New customer" form. */
export const EMPTY_CUSTOMER_DRAFT: CustomerEditDraft = Object.freeze({
  name: "",
  email: "",
  phone: "",
  legalName: "",
  gstin: "",
  address: "",
  city: "",
  state: "",
  pin: "",
  emailVerified: false,
  reason: "",
});

/**
 * Quick checks before sending (the server validates everything again): the person's name and email when creating,
 * and the reason (4-500 characters) always.
 */
export function customerDraftErrors(draft: CustomerEditDraft, mode: "create" | "edit"): Record<string, string> {
  const out: Record<string, string> = {};
  if (mode === "create") {
    if (draft.name.trim() === "") out.name = CUSTOMER_FORM_ERRORS.name;
    if (!isEmailAddress(draft.email.trim().toLowerCase())) out.email = CUSTOMER_FORM_ERRORS.email;
  }
  const reason = validateReason(draft.reason);
  if (!reason.ok) out.reason = reason.message;
  return out;
}

/** POST /api/admin/customers body from the form: empty optional fields left out, "verified" only when ticked. */
export function customerCreatePayload(draft: CustomerEditDraft): Record<string, string | boolean> {
  const body: Record<string, string | boolean> = { name: draft.name.trim(), email: draft.email.trim() };
  for (const key of ["phone", "legalName", "gstin", "address", "city", "state", "pin"] as const) {
    const value = draft[key].trim();
    if (value !== "") body[key] = value;
  }
  if (draft.emailVerified) body.emailVerified = true;
  body.reason = draft.reason.trim();
  return body;
}

/** The edit card's starting values from the drawer detail. */
export function customerEditDraft(c: Pick<AdminCustomerDetail, "legalName" | "gstin" | "address" | "city" | "state" | "pin" | "owner">): CustomerEditDraft {
  return {
    name: c.owner?.name ?? "",
    email: c.owner?.email ?? "",
    phone: c.owner?.phone ?? "",
    legalName: c.legalName,
    gstin: c.gstin ?? "",
    address: c.address ?? "",
    city: c.city ?? "",
    state: c.state ?? "",
    pin: c.pin ?? "",
    emailVerified: false,
    reason: "",
  };
}

/** The draft's email differs from the stored one (case and spaces ignored, as the server normalises). */
export function draftChangesEmail(c: Pick<AdminCustomerDetail, "owner">, draft: Pick<CustomerEditDraft, "email">): boolean {
  return !!c.owner && draft.email.trim().toLowerCase() !== c.owner.email;
}

/**
 * PATCH body of the edit card: only the fields that differ from the stored values (person fields only with an owner),
 * "" sent as null for optional fields, `emailVerified` only with an email change. Excludes the reason.
 */
export function customerEditPatch(c: Pick<AdminCustomerDetail, "legalName" | "gstin" | "address" | "city" | "state" | "pin" | "owner">, draft: CustomerEditDraft): Record<string, string | boolean | null> {
  const start = customerEditDraft(c);
  const patch: Record<string, string | boolean | null> = {};
  const keys = c.owner ? (["name", "phone", "legalName", "gstin", "address", "city", "state", "pin"] as const) : BUSINESS_KEYS;
  for (const key of keys) {
    const value = draft[key].trim();
    if (value === start[key].trim()) continue;
    patch[key] = value === "" && key !== "name" && key !== "legalName" ? null : value;
  }
  if (draftChangesEmail(c, draft)) {
    patch.email = draft.email.trim();
    if (draft.emailVerified) patch.emailVerified = true;
  }
  return patch;
}

/** "Lucknow, Uttar Pradesh" (prototype Location field). */
export function locationLabel(city: string | null, state: string | null): string {
  return [city, state].filter((part): part is string => !!part && part.trim() !== "").join(", ");
}

/** Admin URL of a customer drawer. */
export function adminCustomerHref(id: string): string {
  return `/admin/customers?id=${encodeURIComponent(id)}`;
}
