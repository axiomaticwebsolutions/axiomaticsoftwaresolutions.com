/**
 * Request validation for the customer-portal APIs (Phase 5, F3): billing details, locations, email preferences,
 * profile, two-step, active account, trials, notifications, the orders list and the account search. Bodies are
 * strict (unknown keys rejected, 422); query strings take the first value of each known parameter and ignore the rest.
 * Client-safe: the portal forms reuse the schemas and messages for client-side checks.
 */
import { z } from "zod";
import { BUSINESS_NAME_MAX, NAME_MAX, PASSWORD_INPUT_MAX } from "@/lib/validation/auth";
import { BILLING_ERRORS, BILLING_MAX, cleanLine, gstinStateMismatchMessage, tooLongMessage } from "@/lib/validation/billing";
import { normalizeIndianMobile, PIN_RE } from "@/lib/validation/contact";
import { gstinStateName, isValidGstin, normalizeGstin } from "@/lib/validation/gstin";
import { PRODUCT_ID_RE, RECORD_ID_RE, SEARCH_MAX } from "@/lib/validation/license-actions";
import { isLinkLikeName, NAME_LINK_ERROR } from "@/lib/validation/names";
import { INDIAN_STATES, isIndianState } from "@/lib/validation/states";

/** Bodies of these routes are small; anything larger is refused before parsing (413). */
export const PORTAL_BODY_MAX_BYTES = 8 * 1024;
export const LOCATION_NAME_MAX = 60;
/** Locations per business account (Devices > "Manage locations"). */
export const MAX_LOCATIONS = 100;
export const ORDERS_PAGE_SIZE = 8;
/** Mark-read requests name at most this many notifications; "Mark all read" sends no ids. */
export const MARK_READ_MAX_IDS = 100;

export const PORTAL_ERRORS = {
  /** New copy (the prototype has no empty-name state). */
  legalName: "Enter your legal business name.",
  legalNameTooLong: tooLongMessage(BUSINESS_NAME_MAX),
  /** Prototype (Billing & tax details). */
  gstin: "Enter a valid 15-character GSTIN or leave it blank.",
  /** Prototype (Billing & tax details). */
  pin: "PIN code should be 6 digits.",
  state: BILLING_ERRORS.state,
  /** New copy: a GSTIN needs the state it is registered in (place of supply on future invoices). */
  gstinNeedsState: "Select the state or union territory this GSTIN is registered in.",
  addressTooLong: tooLongMessage(BILLING_MAX.address),
  cityTooLong: tooLongMessage(BILLING_MAX.city),
  nothingToUpdate: "Change at least one field.",
  locationName: "Enter a location name.",
  locationNameTooLong: tooLongMessage(LOCATION_NAME_MAX),
  name: "Enter your name.",
  nameTooLong: tooLongMessage(NAME_MAX),
  nameLink: NAME_LINK_ERROR,
  phone: BILLING_ERRORS.phone,
  password: "Enter your password.",
  account: "Choose one of your businesses.",
  product: "Choose a valid product.",
  ids: "Choose notifications to mark as read.",
  status: "Choose a valid status.",
  sort: "Choose a valid sort order.",
  page: "Choose a valid page.",
  search: tooLongMessage(SEARCH_MAX),
  filter: "Choose All or Unread.",
} as const;

/** "You already have a location called “Andheri”." (new copy; 422 fieldErrors.name). */
export function locationExistsMessage(name: string): string {
  return `You already have a location called \u201c${name}\u201d.`;
}

/** "You can add up to 100 locations." (new copy; 409 location_limit). */
export function locationLimitMessage(max: number = MAX_LOCATIONS): string {
  return `You can add up to ${max} locations.`;
}

/** Optional single-line text: "" and null clear the field (null), otherwise cleaned and length-checked. */
export function optionalLine(max: number, tooLong: string) {
  return z
    .union([z.null(), z.string({ error: tooLong })], { error: tooLong })
    .transform((value) => (value === null ? null : cleanLine(value)))
    .transform((value) => (value === "" ? null : value))
    .refine((value) => value === null || value.length <= max, { message: tooLong });
}

// ---------- Billing & tax details ----------

export const legalNameSchema = z
  .string({ error: PORTAL_ERRORS.legalName })
  .overwrite(cleanLine)
  .superRefine((value, ctx) => {
    if (value.length === 0) ctx.addIssue(PORTAL_ERRORS.legalName);
    else if (value.length > BUSINESS_NAME_MAX) ctx.addIssue(PORTAL_ERRORS.legalNameTooLong);
  });

export const gstinFieldSchema = z
  .union([z.null(), z.string().max(BILLING_MAX.gstinInput, { message: PORTAL_ERRORS.gstin })], { error: PORTAL_ERRORS.gstin })
  .transform((value) => (value === null ? null : normalizeGstin(value)))
  .transform((value) => (value === "" ? null : value))
  .refine((value) => value === null || isValidGstin(value), { message: PORTAL_ERRORS.gstin });

export const stateFieldSchema = z
  .union([z.null(), z.string()], { error: PORTAL_ERRORS.state })
  .transform((value) => (value === null ? null : cleanLine(value)))
  .transform((value) => (value === "" ? null : value))
  .refine((value) => value === null || isIndianState(value), { message: PORTAL_ERRORS.state });

export const pinFieldSchema = z
  .union([z.null(), z.string()], { error: PORTAL_ERRORS.pin })
  .transform((value) => (value === null ? null : value.trim()))
  .transform((value) => (value === "" ? null : value))
  .refine((value) => value === null || PIN_RE.test(value), { message: PORTAL_ERRORS.pin });

/**
 * PATCH /api/account/billing: any subset of the business details; omitted keys stay as they are, "" or null clears
 * an optional field. Output: cleaned single-line text, upper-case GSTIN, a state from INDIAN_STATES, a 6-digit PIN.
 * The GSTIN/state cross-check runs on the merged result (billingDetailsIssue), because either may be omitted.
 */
export const billingDetailsSchema = z
  .strictObject({
    legalName: legalNameSchema.optional(),
    gstin: gstinFieldSchema.optional(),
    address: optionalLine(BILLING_MAX.address, PORTAL_ERRORS.addressTooLong).optional(),
    city: optionalLine(BILLING_MAX.city, PORTAL_ERRORS.cityTooLong).optional(),
    state: stateFieldSchema.optional(),
    pin: pinFieldSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: PORTAL_ERRORS.nothingToUpdate });
export type BillingDetailsInput = z.input<typeof billingDetailsSchema>;
export type BillingDetailsPatch = z.output<typeof billingDetailsSchema>;

export type BillingDetails = {
  legalName: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pin: string | null;
};

/**
 * The GSTIN rule on complete details (decisions.md: format + state-code consistency): a GSTIN needs a billing state
 * and its state code must match it. "Other Territory" GSTINs (code 97) are not cross-checked, as at checkout.
 */
export function billingDetailsIssue(
  details: Pick<BillingDetails, "gstin" | "state">,
): { field: "gstin" | "state"; message: string } | null {
  const { gstin, state } = details;
  if (gstin === null) return null;
  const registered = gstinStateName(gstin);
  if (registered === null) return { field: "gstin", message: PORTAL_ERRORS.gstin };
  if (!isIndianState(registered)) return null;
  if (state === null) return { field: "state", message: PORTAL_ERRORS.gstinNeedsState };
  return registered === state ? null : { field: "gstin", message: gstinStateMismatchMessage(registered) };
}

/** The State / UT choices (the prototype's free-text field becomes a select of the GST states). */
export const BILLING_STATE_OPTIONS = INDIAN_STATES;

// ---------- Locations ----------

/** Trimmed, NFC-normalised, inner whitespace collapsed; 1-60 characters without control characters. */
export const locationNameSchema = z
  .string({ error: PORTAL_ERRORS.locationName })
  .transform((v) => cleanLine(v.normalize("NFC")))
  .pipe(
    z
      .string()
      .min(1, { message: PORTAL_ERRORS.locationName })
      .max(LOCATION_NAME_MAX, { message: PORTAL_ERRORS.locationNameTooLong }),
  );

/** POST /api/account/locations and PATCH /api/account/locations/:id { name }. */
export const locationBodySchema = z.strictObject({ name: locationNameSchema });
export type LocationBody = z.output<typeof locationBodySchema>;

// ---------- Email preferences, profile, two-step, active account, trials ----------

export const EMAIL_PREF_KEYS = ["renewals", "updates", "tickets", "offers"] as const;
export type EmailPrefKey = (typeof EMAIL_PREF_KEYS)[number];

/** Defaults when nothing is stored (prototype: renewals, updates and tickets on, offers off). */
export const DEFAULT_EMAIL_PREFS: Readonly<Record<EmailPrefKey, boolean>> = Object.freeze({
  renewals: true,
  updates: true,
  tickets: true,
  offers: false,
});

/** Switch labels in the prototype's order (Notifications > Email preferences). */
export const EMAIL_PREF_LABELS: Readonly<Record<EmailPrefKey, string>> = Object.freeze({
  renewals: "Renewal reminders",
  updates: "New versions & release notes",
  tickets: "Ticket replies",
  offers: "Offers & announcements",
});

/** PATCH /api/me/preferences (and PATCH /api/account/notifications): any subset of the four switches. */
export const emailPrefsPatchSchema = z
  .strictObject({
    renewals: z.boolean().optional(),
    updates: z.boolean().optional(),
    tickets: z.boolean().optional(),
    offers: z.boolean().optional(),
  })
  .refine((v) => EMAIL_PREF_KEYS.some((k) => v[k] !== undefined), { message: PORTAL_ERRORS.nothingToUpdate });
export type EmailPrefsPatch = z.output<typeof emailPrefsPatchSchema>;

export const personNameSchema = z
  .string({ error: PORTAL_ERRORS.name })
  .transform((v) => cleanLine(v.normalize("NFC")))
  .pipe(
    z
      .string()
      .min(1, { message: PORTAL_ERRORS.name })
      .max(NAME_MAX, { message: PORTAL_ERRORS.nameTooLong })
      .refine((value) => !isLinkLikeName(value), { message: PORTAL_ERRORS.nameLink }),
  );

/** Indian mobile ("+91 98200 00000" -> "9820000000"); "" or null removes the number. */
export const phoneFieldSchema = z
  .union([z.null(), z.string()], { error: PORTAL_ERRORS.phone })
  .transform((value) => (value === null ? "" : value.trim()))
  .superRefine((value, ctx) => {
    if (value !== "" && normalizeIndianMobile(value) === null) ctx.addIssue(PORTAL_ERRORS.phone);
  })
  .transform((value) => (value === "" ? null : (normalizeIndianMobile(value) ?? value)));

/** PATCH /api/me { name?, phone? } (Security > "Your profile"). */
export const profilePatchSchema = z
  .strictObject({ name: personNameSchema.optional(), phone: phoneFieldSchema.optional() })
  .refine((v) => v.name !== undefined || v.phone !== undefined, { message: PORTAL_ERRORS.nothingToUpdate });
export type ProfilePatch = z.output<typeof profilePatchSchema>;

/** POST /api/me/two-step { enabled, password? }: turning it off needs the account password (decisions.md Phase 5). */
export const twoStepSchema = z
  .strictObject({
    enabled: z.boolean({ error: "Choose on or off." }),
    password: z
      .string({ error: PORTAL_ERRORS.password })
      .max(PASSWORD_INPUT_MAX, { message: PORTAL_ERRORS.password })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.enabled && (v.password === undefined || v.password.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["password"], message: PORTAL_ERRORS.password });
    }
  });
export type TwoStepInput = z.output<typeof twoStepSchema>;

/** POST /api/me/active-account { accountId }. Membership is checked on the server (404 otherwise). */
export const activeAccountSchema = z.strictObject({
  accountId: z.string({ error: PORTAL_ERRORS.account }).regex(RECORD_ID_RE, { message: PORTAL_ERRORS.account }),
});

/** POST /api/account/trials { productId }. */
export const startTrialSchema = z.strictObject({
  productId: z.string({ error: PORTAL_ERRORS.product }).regex(PRODUCT_ID_RE, { message: PORTAL_ERRORS.product }),
});

/** POST /api/account/notifications/read { ids? }: no ids marks every unread notification of the user. */
export const markReadSchema = z.strictObject({
  ids: z
    .array(z.string().regex(RECORD_ID_RE, { message: PORTAL_ERRORS.ids }), { error: PORTAL_ERRORS.ids })
    .min(1, { message: PORTAL_ERRORS.ids })
    .max(MARK_READ_MAX_IDS, { message: PORTAL_ERRORS.ids })
    .optional(),
});
export type MarkReadInput = z.output<typeof markReadSchema>;

// ---------- Query strings ----------

/** First value of each known parameter; empty values take the default. Unknown parameters are ignored. */
function pick(params: URLSearchParams, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value.trim() !== "") out[key] = value;
  }
  return out;
}

const searchTextSchema = z.string().trim().max(SEARCH_MAX, { message: PORTAL_ERRORS.search }).default("");

/** Orders list status filter (prototype: All, Paid, Refunded, Pending, Failed, Canceled). */
export const ORDER_STATUS_FILTERS = ["all", "paid", "refunded", "pending", "failed", "canceled"] as const;
export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number];
/** Options of the Orders "Status" select, in the prototype order. */
export const ORDER_STATUS_FILTER_LABELS: Readonly<Record<OrderStatusFilter, string>> = Object.freeze({
  all: "All",
  paid: "Paid",
  refunded: "Refunded",
  pending: "Pending",
  failed: "Failed",
  canceled: "Canceled",
});

export const ORDER_SORT_KEYS = ["date", "status", "total"] as const;
export type OrderSortKey = (typeof ORDER_SORT_KEYS)[number];

export type OrderListQuery = {
  /** Order id or invoice number ("" = no search). */
  q: string;
  status: OrderStatusFilter;
  /** Default: date descending. dir 1 = ascending, -1 = descending. */
  sort: { key: OrderSortKey; dir: 1 | -1 };
  /** 1-based; pages past the end show the last page. */
  page: number;
};

const orderListQuerySchema = z.strictObject({
  q: searchTextSchema,
  status: z.enum(ORDER_STATUS_FILTERS, { message: PORTAL_ERRORS.status }).default("all"),
  sort: z
    .string()
    .regex(new RegExp(`^-?(${ORDER_SORT_KEYS.join("|")})$`), { message: PORTAL_ERRORS.sort })
    .default("-date"),
  page: z.coerce
    .number({ error: PORTAL_ERRORS.page })
    .int({ message: PORTAL_ERRORS.page })
    .min(1, { message: PORTAL_ERRORS.page })
    .max(100_000, { message: PORTAL_ERRORS.page })
    .default(1),
});

/** Parses GET /api/account/orders?q=&status=&sort=&page= ("-key" = descending). Throws ZodError (422). */
export function parseOrderListQuery(params: URLSearchParams): OrderListQuery {
  const parsed = orderListQuerySchema.parse(pick(params, ["q", "status", "sort", "page"]));
  const desc = parsed.sort.startsWith("-");
  return {
    q: parsed.q,
    status: parsed.status,
    sort: { key: (desc ? parsed.sort.slice(1) : parsed.sort) as OrderSortKey, dir: desc ? -1 : 1 },
    page: parsed.page,
  };
}

export type NotificationListQuery = { filter: "all" | "unread"; cursor: string | null };

const notificationListQuerySchema = z.strictObject({
  filter: z.enum(["all", "unread"], { message: PORTAL_ERRORS.filter }).default("all"),
  cursor: z.string().regex(RECORD_ID_RE, { message: PORTAL_ERRORS.ids }).optional(),
});

/** Parses GET /api/account/notifications?filter=all|unread&cursor=<id of the last row seen>. Throws ZodError (422). */
export function parseNotificationListQuery(params: URLSearchParams): NotificationListQuery {
  const parsed = notificationListQuerySchema.parse(pick(params, ["filter", "cursor"]));
  return { filter: parsed.filter, cursor: parsed.cursor ?? null };
}

/** Parses GET /api/account/search?q= (trimmed, at most 100 characters). Throws ZodError (422). */
export function parseSearchQuery(params: URLSearchParams): string {
  return z.strictObject({ q: searchTextSchema }).parse(pick(params, ["q"])).q;
}
