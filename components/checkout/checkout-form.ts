/**
 * Checkout form model (Checkout.dc.html): values, client validation with the prototype's copy, the GSTIN and
 * password helper lines, the tax note, the POST /api/checkout/orders body and the mapping of server field errors.
 * Pure and client-safe. The server validates again with lib/validation/checkout.ts (same rules, same helpers).
 */
import {
  BILLING_ERRORS,
  BILLING_MAX,
  cleanLine,
  gstinStateMismatchMessage,
  tooLongMessage,
} from "@/lib/validation/billing";
import { isEmailAddress, normalizeIndianMobile, PIN_RE } from "@/lib/validation/contact";
import { GSTIN_LENGTH, gstinStateName, isGstinFormat, normalizeGstin } from "@/lib/validation/gstin";
import { isAcceptablePassword, PASSWORD_ERROR } from "@/lib/validation/password";
import { isIndianState } from "@/lib/validation/states";
import { AUTH_COPY } from "@/components/auth/copy";
import type { CheckoutRequestItem } from "@/components/store/cart/cart-model";
import { signInPath } from "@/lib/auth/redirect";

export type CheckoutValues = {
  name: string;
  email: string;
  phone: string;
  business: string;
  address: string;
  city: string;
  pin: string;
  /** "" until a state is chosen. */
  state: string;
  hasGstin: boolean;
  gstin: string;
  createAccount: boolean;
  password: string;
  agree: boolean;
};

export type CheckoutFieldKey =
  | "name"
  | "email"
  | "phone"
  | "password"
  | "business"
  | "address"
  | "city"
  | "pin"
  | "state"
  | "gstin"
  | "agree";

/** Visual order: error summary entries follow it. */
export const CHECKOUT_FIELD_ORDER: readonly CheckoutFieldKey[] = [
  "name",
  "email",
  "phone",
  "password",
  "business",
  "address",
  "city",
  "pin",
  "state",
  "gstin",
  "agree",
];

export type CheckoutErrors = Partial<Record<CheckoutFieldKey, string>>;

/** Prototype copy (Checkout.dc.html) plus the few new strings for states it does not design. */
export const CHECKOUT_COPY = {
  backToCart: "← Back to cart",
  title: "Checkout",
  secure: "Secure checkout",
  emptyTitle: "There’s nothing to check out",
  emptyBody: "Add a plan to your cart first.",
  browse: "Browse software",
  fixFields: "Please fix the highlighted fields.",
  account: "Account",
  signedInAs: (name: string) => `Signed in as ${name}`,
  signedInBody: "Licenses will appear in your account automatically.",
  notYou: "Not you?",
  guestLead: "Checking out as a guest.",
  guestBody:
    "We’ll email your license and invoice. Create a password below, or later sign in with the same email to see your purchases.",
  signIn: "Sign in",
  contact: "Contact details",
  name: "Full name",
  email: "Email",
  emailPlaceholder: "you@business.com",
  phone: "Mobile number",
  phonePlaceholder: "98xxxxxxxx",
  createAccount: "Create an account to manage licenses and downloads",
  password: "Password",
  // The checkout prototype asked for "a number" only; the password policy everywhere needs letters and a number.
  passwordHelp: "At least 8 characters with letters and a number",
  passwordOk: "Strong enough",
  billing: "Billing details",
  billingBody: "Shown on your tax invoice. Your state decides whether CGST + SGST or IGST applies.",
  business: "Business name (optional)",
  address: "Address",
  city: "City",
  pin: "PIN code",
  pinPlaceholder: "411004",
  state: "State / UT",
  statePlaceholder: "Select state",
  gstinToggle: "I have a GSTIN and want to claim input tax credit",
  optional: "(optional)",
  gstin: "GSTIN",
  gstinPlaceholder: "27ABCDE1234F1Z5",
  gstinHint: "Format: 2-digit state code, PAN, entity number, Z, checksum.",
  gstinInvalid: "This doesn’t look like a valid GSTIN.",
  agreePrefix: "I agree to the ",
  eula: "License agreement",
  terms: "Terms",
  refund: "Refund policy",
  newTab: "(opens in a new tab)",
  orderSummary: "Order summary",
  couponLabel: "Coupon code",
  couponPlaceholder: "e.g. WELCOME10",
  apply: "Apply",
  couponApplied: (code: string, label: string) => `${code} applied · ${label}`,
  remove: "Remove",
  sampleCodes: "Sample codes: WELCOME10, ANNUAL500, CHEQUE15, MONSOON25 (expired)",
  subtotal: "Subtotal",
  discount: "Discount",
  taxable: "Taxable value",
  total: "Total",
  pay: (total: string) => `Pay ${total}`,
  creating: "Creating your order…",
  opening: "Opening secure payment…",
  payNote: "You’ll pay on our payment partner’s secure page. Your license is issued only after the payment is confirmed.",
  selectState: "Select your state to confirm the tax type.",
  intraState: (companyState: string) => `Intra-state supply (${companyState}): CGST + SGST.`,
  interState: (state: string) => `Inter-state supply to ${state}: IGST.`,
  // Mirrors CART_INVALID_MESSAGE in lib/checkout/create-order.ts (server-only module).
  cartInvalid: "Some items in your cart can’t be bought as they are. Review your cart and try again.",
  paymentOpenFailed: "We couldn’t open the payment page. Your order is saved, so you can pay for it from the order page.",
  goToOrder: (orderId: string) => `Go to order ${orderId}`,
  loading: "Loading your order",
} as const;

/** Field errors, copied from Checkout.dc.html. */
export const CHECKOUT_ERRORS = {
  name: BILLING_ERRORS.name,
  email: BILLING_ERRORS.email,
  phone: BILLING_ERRORS.phone,
  address: BILLING_ERRORS.address,
  city: BILLING_ERRORS.city,
  pin: BILLING_ERRORS.pin,
  state: BILLING_ERRORS.state,
  gstin: "Enter a valid 15-character GSTIN.",
  password: PASSWORD_ERROR,
  agree: "Please accept the license agreement to continue.",
  couponInvalid: "This code isn’t valid. Check the spelling and try again.",
} as const;

export const EMPTY_CHECKOUT_VALUES: CheckoutValues = {
  name: "",
  email: "",
  phone: "",
  business: "",
  address: "",
  city: "",
  pin: "",
  state: "",
  hasGstin: false,
  gstin: "",
  createAccount: false,
  password: "",
  agree: false,
};

/** Element id of a field's control (the error summary links to it). */
export function checkoutFieldId(key: CheckoutFieldKey): string {
  return `checkout-${key}`;
}

/** GSTIN input sanitising (prototype): upper-case, letters and digits only, at most 15 characters. */
export function sanitizeGstinInput(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, GSTIN_LENGTH);
}

function requiredLine(value: string, message: string, max: number): string | undefined {
  const clean = cleanLine(value);
  if (clean === "") return message;
  if (clean.length > max) return tooLongMessage(max);
  return undefined;
}

/** GSTIN problems in submit order: format (and known state code), then the billing-state cross-check. */
function gstinError(values: Pick<CheckoutValues, "gstin" | "state">): string | undefined {
  const registered = gstinStateName(values.gstin);
  if (registered === null) return CHECKOUT_ERRORS.gstin;
  if (isIndianState(values.state) && isIndianState(registered) && registered !== values.state) {
    return gstinStateMismatchMessage(registered);
  }
  return undefined;
}

/**
 * Client validation (shown after the first submit, then live). `guest` enables the create-account password check.
 * Messages are the prototype's; the rules are the server's (lib/validation/billing.ts, password.ts).
 */
export function validateCheckout(values: CheckoutValues, opts: { guest: boolean }): CheckoutErrors {
  const errors: CheckoutErrors = {};
  const set = (key: CheckoutFieldKey, message: string | undefined) => {
    if (message) errors[key] = message;
  };
  set("name", requiredLine(values.name, CHECKOUT_ERRORS.name, BILLING_MAX.name));
  if (!isEmailAddress(values.email.trim().toLowerCase())) errors.email = CHECKOUT_ERRORS.email;
  if (normalizeIndianMobile(values.phone) === null) errors.phone = CHECKOUT_ERRORS.phone;
  if (opts.guest && values.createAccount && !isAcceptablePassword(values.password)) errors.password = CHECKOUT_ERRORS.password;
  if (cleanLine(values.business).length > BILLING_MAX.business) errors.business = tooLongMessage(BILLING_MAX.business);
  set("address", requiredLine(values.address, CHECKOUT_ERRORS.address, BILLING_MAX.address));
  set("city", requiredLine(values.city, CHECKOUT_ERRORS.city, BILLING_MAX.city));
  if (!PIN_RE.test(values.pin.trim())) errors.pin = CHECKOUT_ERRORS.pin;
  if (!isIndianState(values.state)) errors.state = CHECKOUT_ERRORS.state;
  if (values.hasGstin) set("gstin", gstinError(values));
  if (!values.agree) errors.agree = CHECKOUT_ERRORS.agree;
  return errors;
}

export type HelperTone = "neutral" | "valid" | "error";
export type HelperLine = { message: string; tone: HelperTone };

/**
 * The line under the GSTIN input: the format hint, "{n} more characters", "This doesn’t look like a valid GSTIN.",
 * a billing-state mismatch, or "Valid format · {state}" (the prototype only knew code 27; we know every code).
 * A submit error takes precedence.
 */
export function gstinHelper(gstin: string, state: string, error?: string): HelperLine {
  if (error) return { message: error, tone: "error" };
  const value = normalizeGstin(gstin);
  if (value === "") return { message: CHECKOUT_COPY.gstinHint, tone: "neutral" };
  if (value.length < GSTIN_LENGTH) {
    const left = GSTIN_LENGTH - value.length;
    return { message: `${left} more ${left === 1 ? "character" : "characters"}`, tone: "neutral" };
  }
  const registered = isGstinFormat(value) ? gstinStateName(value) : null;
  if (registered === null) return { message: CHECKOUT_COPY.gstinInvalid, tone: "neutral" };
  if (isIndianState(state) && isIndianState(registered) && registered !== state) {
    return { message: gstinStateMismatchMessage(registered), tone: "neutral" };
  }
  return { message: `Valid format · ${registered}`, tone: "valid" };
}

/** The create-account password help: neutral hint, "Strong enough", or the submit error. */
export function passwordHelper(password: string, error?: string): HelperLine {
  if (error) return { message: error, tone: "error" };
  return isAcceptablePassword(password)
    ? { message: CHECKOUT_COPY.passwordOk, tone: "valid" }
    : { message: CHECKOUT_COPY.passwordHelp, tone: "neutral" };
}

/** True when billing in `state` is an intra-state supply (no state yet = the company's state, as the server quotes). */
export function isIntraState(state: string, companyState: string): boolean {
  return state === "" || state === companyState;
}

/** The note under the totals. */
export function taxNote(state: string, companyState: string): string {
  if (state === "") return CHECKOUT_COPY.selectState;
  return state === companyState ? CHECKOUT_COPY.intraState(companyState) : CHECKOUT_COPY.interState(state);
}

/** "Priya Sharma" -> "PS" (the signed-in avatar). */
export function initialsOf(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => Array.from(part)[0] ?? "")
    .join("");
  return initials.slice(0, 2).toUpperCase();
}

export type CreateOrderBody = {
  items: CheckoutRequestItem[];
  couponCode?: string;
  billing: {
    name: string;
    email: string;
    phone: string;
    business?: string;
    address: string;
    city: string;
    state: string;
    pin: string;
    gstin?: string;
  };
  createAccount?: { password: string };
  acceptTerms: true;
};

/** POST /api/checkout/orders body. The GSTIN is sent only while its toggle is on; the password only for guests. */
export function toCreateOrderBody(
  values: CheckoutValues,
  items: readonly CheckoutRequestItem[],
  opts: { couponCode: string | null; guest: boolean },
): CreateOrderBody {
  const business = cleanLine(values.business);
  const gstin = values.hasGstin ? normalizeGstin(values.gstin) : "";
  return {
    items: [...items],
    ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
    billing: {
      name: cleanLine(values.name),
      email: values.email.trim().toLowerCase(),
      phone: values.phone.trim(),
      ...(business ? { business } : {}),
      address: cleanLine(values.address),
      city: cleanLine(values.city),
      state: values.state,
      pin: values.pin.trim(),
      ...(gstin ? { gstin } : {}),
    },
    ...(opts.guest && values.createAccount ? { createAccount: { password: values.password } } : {}),
    acceptTerms: true,
  };
}

const SERVER_FIELD_MAP: Readonly<Record<string, CheckoutFieldKey>> = {
  "billing.name": "name",
  "billing.email": "email",
  "billing.phone": "phone",
  "billing.business": "business",
  "billing.address": "address",
  "billing.city": "city",
  "billing.pin": "pin",
  "billing.state": "state",
  "billing.gstin": "gstin",
  "createAccount.password": "password",
  acceptTerms: "agree",
};

/** 422 `validation_failed` field paths -> form fields; the coupon message is returned separately. */
export function mapServerFieldErrors(fieldErrors: Readonly<Record<string, readonly string[]>>): {
  fields: CheckoutErrors;
  coupon: string | null;
  other: string | null;
} {
  const fields: CheckoutErrors = {};
  let coupon: string | null = null;
  let other: string | null = null;
  for (const [path, messages] of Object.entries(fieldErrors)) {
    const message = messages[0];
    if (!message) continue;
    const key = SERVER_FIELD_MAP[path];
    if (key) fields[key] ??= message;
    else if (path === "couponCode") coupon ??= message;
    else other ??= message;
  }
  return { fields, coupon, other };
}

/** Where checkout lives (the sign-in link comes back here). */
export const CHECKOUT_PATH = "/checkout";

/**
 * The form-level alert at the top of checkout (server error, cart problem, payment page that would not open). An
 * `inline` link reads on in the same sentence ("… already exists. Sign in instead."); otherwise it goes below.
 */
export type CheckoutFormError = {
  message: string;
  link?: {
    href: string;
    label: string;
    inline?: boolean;
    /** Hand the typed email to the sign-in form on click (sessionStorage, never the URL). */
    handOffEmail?: boolean;
  };
};

/**
 * 409 `email_taken` from "Create an account": the prototype replaces the form error with the server message; as on
 * /register, "Sign in instead." is a link (back to checkout after signing in). The email field keeps the lead as its
 * own error (aria-invalid), but the field summary stays hidden (showFieldSummary), so there is one alert.
 */
export function emailTakenFormError(): CheckoutFormError {
  return {
    message: AUTH_COPY.register.emailTakenLead,
    link: { href: signInPath(CHECKOUT_PATH), label: AUTH_COPY.register.emailTakenLink, inline: true, handOffEmail: true },
  };
}

/** The one-line field summary ("Please fix the highlighted fields.") shows only while no form-level alert does. */
export function showFieldSummary(fieldErrorCount: number, formError: CheckoutFormError | null): boolean {
  return fieldErrorCount > 0 && formError === null;
}
