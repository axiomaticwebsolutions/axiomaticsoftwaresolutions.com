/**
 * Billing & tax details view model (Customer Portal.dc.html "Billing & tax"; decisions.md Phase 5). Pure and
 * client-safe: form values, client validation with the prototype's copy and the server's rules
 * (lib/validation/portal billingDetailsSchema + billingDetailsIssue), the PATCH body, server field errors, the live
 * GSTIN line and the payment-history labels and CSV columns.
 */
import type { CsvColumn } from "@/lib/csv";
import { formatDateIST, istParts } from "@/lib/dates";
import { formatINR, paiseToDecimalString } from "@/lib/money";
import type { BillingView, InvoiceContact, PaymentHistoryRow } from "@/lib/portal/billing";
import { BUSINESS_NAME_MAX } from "@/lib/validation/auth";
import { BILLING_MAX, cleanLine, gstinStateMismatchMessage } from "@/lib/validation/billing";
import { PIN_RE } from "@/lib/validation/contact";
import { GSTIN_LENGTH, gstinStateName, isGstinFormat, isValidGstin, normalizeGstin } from "@/lib/validation/gstin";
import { billingDetailsIssue, PORTAL_ERRORS, type BillingDetails } from "@/lib/validation/portal";
import { isIndianState } from "@/lib/validation/states";

export type { BillingView, InvoiceContact, PaymentHistoryRow };

/** GET/PATCH /api/account/billing (F3) body: the billing view plus whether the member may edit. */
export type BillingResponse = BillingView & { canEdit: boolean; changed?: boolean };

export const BILLING_API_PATH = "/api/account/billing";
export const PAYMENTS_CSV_FILE_NAME = "payments.csv";

/** Copy from the prototype unless marked new. */
export const BILLING_COPY = {
  title: "Billing & tax details",
  description: "Business details for GST invoices, invoice contacts and payment history.",
  formTitle: "Business & tax details",
  formDescription: "Printed on future tax invoices. Past invoices don’t change.",
  /** New copy: the State / UT select's empty option (the prototype field was free text). */
  statePlaceholder: "Select state or UT",
  save: "Save details",
  saved: "Billing details saved",
  /** New copy. */
  saveFailed: "Couldn’t save your details. Try again.",
  contactsTitle: "Invoice delivery",
  contactsDescription: "Tax invoices and renewal reminders are emailed to these contacts.",
  /** New copy (an account always keeps an Owner, so this is a fallback). */
  contactsEmpty: "No invoice contacts yet.",
  manageTeam: "Manage in Team & access",
  methodsTitle: "Payment methods",
  /**
   * Reworded (decisions.md rule 2: no mandates, renewals are manual). Prototype: "… Subscriptions use a mandate you
   * can cancel from your bank or UPI app."
   */
  methodsBody:
    "We don’t store cards or UPI IDs. Each payment is made on our payment partner’s secure page. Nothing is charged automatically: you renew licenses and subscriptions yourself from the portal.",
  historyTitle: "Payment history",
  exportCsv: "Export CSV",
  /** New copy (the prototype has no empty payment history). */
  paymentsEmpty: "No payments yet.",
  /** New copy: GET /api/account/billing lists the newest 100 payments. */
  loadError: "We couldn’t load your billing details.",
  retry: "Try again",
} as const;

export type BillingFieldKey = "legalName" | "gstin" | "state" | "address" | "city" | "pin";
export type BillingFormValues = Record<BillingFieldKey, string>;
export type BillingFormErrors = Partial<Record<BillingFieldKey, string>>;

/** Prototype field order (Legal business name, GSTIN, State / UT, Registered address, City, PIN code). */
export const BILLING_FIELDS: readonly BillingFieldKey[] = ["legalName", "gstin", "state", "address", "city", "pin"];

export const BILLING_LABELS: Readonly<Record<BillingFieldKey, string>> = {
  legalName: "Legal business name",
  gstin: "GSTIN (optional)",
  state: "State / UT",
  address: "Registered address",
  city: "City",
  pin: "PIN code",
};

/** "Showing the latest 100 payments." (new copy) */
export function paymentsTruncatedLabel(count: number): string {
  return `Showing the latest ${count.toLocaleString("en-IN")} payments.`;
}

/** Stored details -> form strings ("" for empty optional fields). */
export function billingFormValues(details: BillingDetails): BillingFormValues {
  return {
    legalName: details.legalName,
    gstin: details.gstin ?? "",
    state: details.state ?? "",
    address: details.address ?? "",
    city: details.city ?? "",
    pin: details.pin ?? "",
  };
}

/** The GSTIN input upper-cases as you type (prototype). */
export function gstinInput(raw: string): string {
  return raw.toUpperCase();
}

/**
 * Client validation with the server's rules. Copy: the prototype's GSTIN and PIN messages; the legal-name, State / UT,
 * length and GSTIN/state messages are the API's (lib/validation/portal PORTAL_ERRORS, lib/validation/billing).
 */
export function validateBillingForm(values: BillingFormValues): BillingFormErrors {
  const errors: BillingFormErrors = {};
  const legalName = cleanLine(values.legalName);
  if (legalName === "") errors.legalName = PORTAL_ERRORS.legalName;
  else if (legalName.length > BUSINESS_NAME_MAX) errors.legalName = PORTAL_ERRORS.legalNameTooLong;

  const gstin = normalizeGstin(values.gstin);
  if (gstin !== "" && (values.gstin.length > BILLING_MAX.gstinInput || !isValidGstin(gstin))) errors.gstin = PORTAL_ERRORS.gstin;

  const state = values.state.trim();
  if (state !== "" && !isIndianState(state)) errors.state = PORTAL_ERRORS.state;

  if (cleanLine(values.address).length > BILLING_MAX.address) errors.address = PORTAL_ERRORS.addressTooLong;
  if (cleanLine(values.city).length > BILLING_MAX.city) errors.city = PORTAL_ERRORS.cityTooLong;

  const pin = values.pin.trim();
  if (pin !== "" && !PIN_RE.test(pin)) errors.pin = PORTAL_ERRORS.pin;

  if (gstin !== "" && !errors.gstin && !errors.state) {
    const issue = billingDetailsIssue({ gstin, state: state === "" ? null : state });
    if (issue) errors[issue.field] = issue.message;
  }
  return errors;
}

/** The first field (in form order) with an error, for focus after a failed save. */
export function firstInvalidField(errors: BillingFormErrors): BillingFieldKey | null {
  return BILLING_FIELDS.find((key) => errors[key] !== undefined) ?? null;
}

export type BillingPatchBody = {
  legalName: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pin: string | null;
};

function optional(value: string): string | null {
  const cleaned = cleanLine(value);
  return cleaned === "" ? null : cleaned;
}

/** PATCH /api/account/billing body: every field; null clears an optional one (the server cleans again). */
export function billingPatchBody(values: BillingFormValues): BillingPatchBody {
  const gstin = normalizeGstin(values.gstin);
  return {
    legalName: cleanLine(values.legalName),
    gstin: gstin === "" ? null : gstin,
    address: optional(values.address),
    city: optional(values.city),
    state: optional(values.state),
    pin: optional(values.pin),
  };
}

/** 422 fieldErrors from the API -> one message per known field. */
export function billingServerErrors(fieldErrors: Readonly<Record<string, readonly string[]>>): BillingFormErrors {
  const errors: BillingFormErrors = {};
  for (const key of BILLING_FIELDS) {
    const message = fieldErrors[key]?.[0];
    if (message) errors[key] = message;
  }
  return errors;
}

export type HelperTone = "neutral" | "valid" | "error";
export type HelperLine = { message: string; tone: HelperTone };

/**
 * The live line under the GSTIN input (as at checkout): nothing while empty, "{n} more characters", the prototype's
 * invalid-GSTIN copy, a GSTIN/State mismatch, or "Valid format · {state}". A validation error takes precedence.
 */
export function gstinHelper(gstin: string, state: string, error?: string): HelperLine | null {
  if (error) return { message: error, tone: "error" };
  const value = normalizeGstin(gstin);
  if (value === "") return null;
  if (value.length < GSTIN_LENGTH) {
    const left = GSTIN_LENGTH - value.length;
    return { message: `${left} more ${left === 1 ? "character" : "characters"}`, tone: "neutral" };
  }
  const registered = isGstinFormat(value) ? gstinStateName(value) : null;
  if (registered === null) return { message: PORTAL_ERRORS.gstin, tone: "neutral" };
  if (isIndianState(state) && isIndianState(registered) && registered !== state) {
    return { message: gstinStateMismatchMessage(registered), tone: "neutral" };
  }
  return { message: `Valid format · ${registered}`, tone: "valid" };
}

// ---------- Payment history ----------

/** "17 Sep 2026" (IST). */
export function paymentDateLabel(row: Pick<PaymentHistoryRow, "createdAt">): string {
  return formatDateIST(new Date(row.createdAt));
}

/** "₹4,128.82" (payments always show paise, as in the prototype). */
export function paymentAmountLabel(row: Pick<PaymentHistoryRow, "amountPaise">): string {
  return formatINR(row.amountPaise, { exact: true });
}

/** "UPI", "Card", or an em dash before the payment partner reports a method. */
export function paymentMethodLabel(row: Pick<PaymentHistoryRow, "method">): string {
  return row.method?.trim() ? row.method : "—";
}

/** "2026-10-07": the IST calendar date (spreadsheets parse ISO dates; same as the orders CSV). */
export function istIsoDate(iso: string): string {
  const p = istParts(new Date(iso));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * payments.csv (prototype columns: Date, Payment ID, Order, Method, Status, Amount). Status is the badge label and
 * Amount is rupees with 2 decimals; lib/csv quotes every cell and guards formula-like text.
 */
export const PAYMENT_CSV_COLUMNS: readonly CsvColumn<PaymentHistoryRow>[] = [
  { header: "Date", value: (p) => istIsoDate(p.createdAt) },
  { header: "Payment ID", value: (p) => p.reference ?? "" },
  { header: "Order", value: (p) => p.orderId },
  { header: "Method", value: (p) => p.method ?? "" },
  { header: "Status", value: (p) => p.badge.label },
  { header: "Amount", value: (p) => paiseToDecimalString(p.amountPaise) },
];

/** Invoice contact row: email, then the role label ("Owner", "Billing admin"). */
export function contactKey(contact: Pick<InvoiceContact, "userId">): string {
  return contact.userId;
}
