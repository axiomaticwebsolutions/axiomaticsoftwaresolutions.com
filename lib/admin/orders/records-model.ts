/**
 * Admin records PART B (docs/admin-records-design.md B1-B11; decisions.md "Admin records", 2026-10-08): the pure rules,
 * messages, copy and form helpers of creating, editing, cancelling and correcting orders in Admin > Orders. Pure and
 * client-safe: the services (lib/admin/orders/create.ts, offline.ts, edit.ts, correction.ts), the order drawer and the
 * "New order" drawer share them, and unit tests cover them.
 */
import { ItemKind, PlanType } from "@/generated/prisma/enums";
import { DAY_MS, formatDateIST, istParts } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { ITEM_KIND_PLAN_TYPES } from "@/lib/pricing";
import { OFFLINE_METHOD_LABELS, OFFLINE_METHODS, type OfflineMethod } from "./model";

// ---------- Rules ----------

/** "Received on" can go back this far (IST calendar days, today included). */
export const OFFLINE_RECEIVED_MAX_AGE_DAYS = 180;
/** Payment links are order links (lib/orders/token.ts): they work for 30 days. */
export const PAYMENT_LINK_DAYS = 30;

/** Order statuses an unpaid-order edit, a staff cancel and a payment link start from. */
export const UNPAID_EDITABLE_STATUSES = ["AWAITING_PAYMENT", "FAILED", "CANCELED"] as const;
const PAID_STATUSES = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);
/** A payment is settling: the order must not change under it. */
const SETTLING_ORDER_STATUSES = new Set(["PENDING", "CONFIRMING", "REVIEW"]);
const SETTLING_PAYMENT_STATUSES = new Set(["AUTHORIZED", "CAPTURED"]);
/** Refunds that already cancel part of the invoice (a correction would credit it twice). */
const OPEN_REFUND_STATUSES = new Set(["PENDING", "PROCESSED"]);

/** Server error messages (API `message` / fieldErrors). */
export const ORDER_RECORD_MESSAGES = {
  notEditable: "Only unpaid orders can be edited. Paid orders keep their amounts; refund or correct the billing instead.",
  paymentInProgress: "A payment for this order is being confirmed, so it can’t change now.",
  orderCanceled: "This order was cancelled by our team. Create a new order instead.",
  notCancelable: "Only unpaid orders can be cancelled. Refund paid orders instead.",
  notPayable: "Only unpaid orders that weren’t cancelled by our team can be paid.",
  notCorrectable: "Only paid orders with a tax invoice and no refunds can be corrected.",
  stateLocked:
    "The billing state sets the GST split, so it can’t change on a paid order. Refund the order and create a new one instead.",
  emailLocked: "The order email can’t change on a paid order.",
  gstinStateSuffix: " The billing state can’t change on a paid order.",
  nothingChanged: "Change a billing detail before issuing a corrected invoice.",
  sellerStateChanged:
    "Your business state or GSTIN in Settings differs from the original invoice, so a credit note can’t cancel it from here. Contact your accountant.",
  receivedOn: `Enter a date in the last ${OFFLINE_RECEIVED_MAX_AGE_DAYS} days, not in the future.`,
  referenceRequired: "Enter the UTR or reference number.",
  chequeRequired: "Enter the cheque number.",
  referenceInvalid: "Use letters, numbers, spaces and / . _ - only.",
  duplicateRequest: "This form was already submitted by another staff member. Close it and start again.",
  quoteTarget: "Choose a customer or an order.",
  nothingToUpdate: "Change the items, coupon or billing before saving.",
  canceledReason: "Cancelled by our team.",
  offlineRefund: "Refunds of offline payments aren’t available in the console yet.",
  amountMismatch: (totalPaise: number) =>
    `The amount must equal the order total, ${formatINR(totalPaise, { exact: true })}. Partial payments can’t be recorded.`,
  tryAgain: "The database was busy, so nothing was saved. Try again in a moment.",
  fulfilmentFailed: (code: string) => `We couldn’t issue this order (${code}). Nothing was saved. Check the items and try again.`,
} as const;

/** Drawer notes for a locked edit card. */
export const EDIT_LOCK_REASONS = {
  paid: "Paid orders keep their items and amounts.",
  settling: "A payment is being confirmed, so the order can’t change now.",
  canceledByStaff: "This order was cancelled by our team.",
} as const;

type OrderStateInput = {
  status: string;
  canceledByStaffAt: Date | string | null;
  payments: readonly { status: string }[];
};

/** Whether "Edit order" (and the staff cancel) may change this order, and why not. */
export function orderEditState(order: OrderStateInput): { allowed: boolean; reason: string | null } {
  if (PAID_STATUSES.has(order.status)) return { allowed: false, reason: EDIT_LOCK_REASONS.paid };
  if (order.canceledByStaffAt) return { allowed: false, reason: EDIT_LOCK_REASONS.canceledByStaff };
  if (SETTLING_ORDER_STATUSES.has(order.status) || order.payments.some((p) => SETTLING_PAYMENT_STATUSES.has(p.status))) {
    return { allowed: false, reason: EDIT_LOCK_REASONS.settling };
  }
  return { allowed: (UNPAID_EDITABLE_STATUSES as readonly string[]).includes(order.status), reason: null };
}

/** The 409 an unpaid-order edit or staff cancel answers for this order, or null when it may change. */
export function orderLockError(
  order: OrderStateInput,
  op: "edit" | "cancel",
): { code: "not_editable" | "not_cancelable" | "payment_in_progress" | "order_canceled"; message: string } | null {
  if (PAID_STATUSES.has(order.status)) {
    return op === "edit"
      ? { code: "not_editable", message: ORDER_RECORD_MESSAGES.notEditable }
      : { code: "not_cancelable", message: ORDER_RECORD_MESSAGES.notCancelable };
  }
  if (order.canceledByStaffAt && op === "edit") return { code: "order_canceled", message: ORDER_RECORD_MESSAGES.orderCanceled };
  if (SETTLING_ORDER_STATUSES.has(order.status) || order.payments.some((p) => SETTLING_PAYMENT_STATUSES.has(p.status))) {
    return { code: "payment_in_progress", message: ORDER_RECORD_MESSAGES.paymentInProgress };
  }
  if (!(UNPAID_EDITABLE_STATUSES as readonly string[]).includes(order.status)) {
    return op === "edit"
      ? { code: "not_editable", message: ORDER_RECORD_MESSAGES.notEditable }
      : { code: "not_cancelable", message: ORDER_RECORD_MESSAGES.notCancelable };
  }
  return null;
}

/** "Payment link": an unpaid order (awaiting payment, failed or cancelled by the customer) staff did not cancel. */
export function paymentLinkAllowed(order: Pick<OrderStateInput, "status" | "canceledByStaffAt">): boolean {
  return (UNPAID_EDITABLE_STATUSES as readonly string[]).includes(order.status) && !order.canceledByStaffAt;
}

/**
 * "Correct billing": PAID with a tax invoice and no PENDING or PROCESSED refund. `reason` is null for unpaid orders
 * (the action is hidden) and the refusal text for paid ones.
 */
export function orderCorrectionState(order: {
  status: string;
  hasInvoice: boolean;
  refunds: readonly { status: string }[];
}): { allowed: boolean; reason: string | null } {
  const paid = PAID_STATUSES.has(order.status);
  if (!paid) return { allowed: false, reason: null };
  const allowed = order.status === "PAID" && order.hasInvoice && !order.refunds.some((r) => OPEN_REFUND_STATUSES.has(r.status));
  return allowed ? { allowed: true, reason: null } : { allowed: false, reason: ORDER_RECORD_MESSAGES.notCorrectable };
}

/** "YYYY-MM-DD" of `now` in IST. */
export function istToday(now: Date): string {
  const p = istParts(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The earliest "Received on" date accepted at `now` (IST): today minus OFFLINE_RECEIVED_MAX_AGE_DAYS. */
export function earliestReceivedOn(now: Date): string {
  return istToday(new Date(now.getTime() - OFFLINE_RECEIVED_MAX_AGE_DAYS * DAY_MS));
}

/** null when `receivedOn` ("YYYY-MM-DD", an IST calendar day) is within the last 180 days and not in the future. */
export function receivedOnIssue(receivedOn: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) return ORDER_RECORD_MESSAGES.receivedOn;
  return receivedOn > istToday(now) || receivedOn < earliestReceivedOn(now) ? ORDER_RECORD_MESSAGES.receivedOn : null;
}

/** Methods whose reference is required (UTR for UPI and bank transfers, the cheque number). */
export function referenceRequiredMessage(method: OfflineMethod): string | null {
  if (method === "cheque") return ORDER_RECORD_MESSAGES.chequeRequired;
  if (method === "upi" || method === "bank_transfer") return ORDER_RECORD_MESSAGES.referenceRequired;
  return null;
}

// ---------- Items ----------

/** Lines that apply to an existing license (renewals, upgrades, add-ons and maintenance) need a target. */
export function lineNeedsTarget(kind: ItemKind, planType: PlanType): boolean {
  return kind !== ItemKind.NEW || planType === PlanType.DEVICE_ADDON || planType === PlanType.MAINTENANCE;
}

/** Item kinds a plan type can be sold as (lib/pricing ITEM_KIND_PLAN_TYPES), in form order. */
export function kindsForPlanType(planType: PlanType): ItemKind[] {
  return ([ItemKind.NEW, ItemKind.RENEWAL, ItemKind.UPGRADE, ItemKind.ADDON] as const).filter((k) => ITEM_KIND_PLAN_TYPES[k].includes(planType));
}

export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  NEW: "New license",
  RENEWAL: "Renewal",
  UPGRADE: "Upgrade",
  ADDON: "Add-on",
};

/** A plan the "New order" form can sell (lib/admin/orders/queries.ts adminOrderPlanOptions). */
export type AdminOrderPlanOption = {
  id: string;
  productId: string;
  productName: string;
  planName: string;
  type: PlanType;
  pricePaise: number;
  perUnit: string | null;
  maxQty: number | null;
  /** NEW lines need a published product; renewals and add-ons only one that is not a draft. */
  productPublished: boolean;
};

/** The quantity field shows for per-unit plans and add-ons (one license otherwise). */
export function lineHasQuantity(plan: Pick<AdminOrderPlanOption, "perUnit" | "type">, kind: ItemKind): boolean {
  return plan.perUnit !== null || kind === ItemKind.ADDON || plan.type === PlanType.DEVICE_ADDON;
}

export function lineMaxQty(plan: Pick<AdminOrderPlanOption, "maxQty">): number {
  return Math.max(1, plan.maxQty ?? 10);
}

// ---------- Form drafts (strings; empty = none) ----------

export type OrderLineDraft = { key: string; planId: string; kind: ItemKind; targetLicenseId: string; qty: string };

export type OrderBillingDraft = {
  name: string;
  email: string;
  phone: string;
  business: string;
  address: string;
  city: string;
  state: string;
  pin: string;
  gstin: string;
};

export const EMPTY_BILLING_DRAFT: OrderBillingDraft = { name: "", email: "", phone: "", business: "", address: "", city: "", state: "", pin: "", gstin: "" };

export type OrderPaymentMode = "link" | "offline";

export type OrderFormDraft = {
  lines: OrderLineDraft[];
  couponCode: string;
  billing: OrderBillingDraft;
  mode: OrderPaymentMode;
  method: OfflineMethod;
  reference: string;
  receivedOn: string;
  amount: string;
  reason: string;
};

let lineSeq = 0;
/** A fresh empty line (its key only identifies the row in the form). */
export function emptyLine(): OrderLineDraft {
  lineSeq += 1;
  return { key: `line-${lineSeq}`, planId: "", kind: ItemKind.NEW, targetLicenseId: "", qty: "1" };
}

export function emptyOrderDraft(today: string): OrderFormDraft {
  return {
    lines: [emptyLine()],
    couponCode: "",
    billing: { ...EMPTY_BILLING_DRAFT },
    mode: "link",
    method: "cash",
    reference: "",
    receivedOn: today,
    amount: "",
    reason: "",
  };
}

/** Prefill of the billing fields from a customer: the owner's name, email and mobile; the account's business details. */
export function billingDraftFromCustomer(c: {
  legalName: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pin: string | null;
  owner: { name: string; email: string; phone: string | null } | null;
}): OrderBillingDraft {
  return {
    name: c.owner?.name ?? "",
    email: c.owner?.email ?? "",
    phone: c.owner?.phone ?? "",
    business: c.legalName,
    address: c.address ?? "",
    city: c.city ?? "",
    state: c.state ?? "",
    pin: c.pin ?? "",
    gstin: c.gstin ?? "",
  };
}

/** The billing fields of a stored snapshot (the edit card and "Correct billing"). */
export function billingDraftFromSnapshot(b: {
  name: string;
  email: string;
  phone: string;
  business: string | null;
  address: string;
  city: string;
  state: string;
  pin: string;
  gstin: string | null;
}): OrderBillingDraft {
  return {
    name: b.name,
    email: b.email,
    phone: b.phone,
    business: b.business ?? "",
    address: b.address,
    city: b.city,
    state: b.state,
    pin: b.pin,
    gstin: b.gstin ?? "",
  };
}

export type OrderItemPayload = { planId: string; qty: number; kind: ItemKind; targetLicenseId: string | null };

/**
 * The items of the request (lines with a plan; the server re-validates and re-prices everything). A line whose plan is
 * no longer offered (an unpaid order's archived plan) is sent as it stands, so the server decides.
 */
export function orderItemsPayload(lines: readonly OrderLineDraft[], plans: readonly AdminOrderPlanOption[]): OrderItemPayload[] {
  const byId = new Map(plans.map((p) => [p.id, p]));
  return lines.flatMap((line) => {
    if (!line.planId) return [];
    const plan = byId.get(line.planId);
    if (!plan) {
      const qty = Number(line.qty);
      return [{ planId: line.planId, qty: Number.isInteger(qty) && qty >= 1 ? qty : 1, kind: line.kind, targetLicenseId: line.targetLicenseId || null }];
    }
    const qty = lineHasQuantity(plan, line.kind) ? Number(line.qty) : 1;
    return [
      {
        planId: plan.id,
        qty: Number.isInteger(qty) && qty >= 1 ? qty : 1,
        kind: line.kind,
        targetLicenseId: lineNeedsTarget(line.kind, plan.type) && line.targetLicenseId ? line.targetLicenseId : null,
      },
    ];
  });
}

/** "5,898.82", "₹5898.82" or "5898" -> paise; null when it is not an amount. */
export function rupeesToPaise(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** The billing payload: strings as typed (the server trims, validates and normalises like checkout). */
export function billingPayload(b: OrderBillingDraft): Record<keyof OrderBillingDraft, string> {
  return { ...b };
}

export type OrderFormErrors = Record<string, string>;

/**
 * Client checks before the request (the server checks everything again): a customer, at least one complete line with
 * its target, a reason, and in offline mode the method's reference, the date and the amount.
 */
export function orderFormErrors(
  draft: OrderFormDraft,
  plans: readonly AdminOrderPlanOption[],
  opts: { needCustomer: boolean; hasCustomer: boolean; payment: boolean; now: Date },
): OrderFormErrors {
  const errors: OrderFormErrors = {};
  if (opts.needCustomer && !opts.hasCustomer) errors.accountId = ORDER_RECORD_COPY.chooseCustomer;
  const byId = new Map(plans.map((p) => [p.id, p]));
  draft.lines.forEach((line, i) => {
    const plan = byId.get(line.planId);
    if (!line.planId) {
      errors[`items.${i}.planId`] = ORDER_RECORD_COPY.choosePlan;
      return;
    }
    if (!plan) return;
    if (lineNeedsTarget(line.kind, plan.type) && !line.targetLicenseId) errors[`items.${i}.targetLicenseId`] = ORDER_RECORD_COPY.chooseLicense;
    if (lineHasQuantity(plan, line.kind)) {
      const qty = Number(line.qty);
      const max = lineMaxQty(plan);
      if (!Number.isInteger(qty) || qty < 1 || qty > max) errors[`items.${i}.qty`] = `Enter a quantity from 1 to ${max}.`;
    }
  });
  if (draft.lines.length === 0) errors.items = ORDER_RECORD_COPY.addItem;
  if (draft.reason.trim().length < 4) errors.reason = "Add a short reason for the audit log.";
  if (opts.payment && draft.mode === "offline") {
    const refMessage = referenceRequiredMessage(draft.method);
    if (refMessage && draft.reference.trim() === "") errors.reference = refMessage;
    const dateIssue = receivedOnIssue(draft.receivedOn, opts.now);
    if (dateIssue) errors.receivedOn = dateIssue;
    if (rupeesToPaise(draft.amount) === null) errors.amountPaise = ORDER_RECORD_COPY.amountInvalid;
  }
  return errors;
}

// ---------- Audit helpers ----------

/** Field names of a billing snapshot that differ (normalised values), in a fixed order. */
export const BILLING_FIELD_ORDER = ["name", "email", "phone", "business", "address", "city", "state", "pin", "gstin"] as const;

export function changedBillingFields(
  before: Record<(typeof BILLING_FIELD_ORDER)[number], string | null>,
  after: Record<(typeof BILLING_FIELD_ORDER)[number], string | null>,
): string[] {
  return BILLING_FIELD_ORDER.filter((key) => (before[key] ?? "") !== (after[key] ?? ""));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Payment link · ₹5,898.82 · 2 items · coupon DIWALI10 · for Sharma Medicals" */
export function paymentLinkAuditDetail(input: { totalPaise: number; items: number; couponCode: string | null; legalName: string }): string {
  return [
    "Payment link",
    formatINR(input.totalPaise, { exact: true }),
    plural(input.items, "item"),
    ...(input.couponCode ? [`coupon ${input.couponCode}`] : []),
    `for ${input.legalName}`,
  ].join(" · ");
}

/** "UPI · ref 4211… · ₹5,898.82 received 7 Oct 2026 · Invoice AXS/… · 1 license issued, 0 updated · for …" */
export function offlineAuditDetail(input: {
  method: OfflineMethod;
  reference: string | null;
  totalPaise: number;
  receivedAt: Date;
  invoiceNumber: string;
  issued: number;
  updated: number;
  legalName: string;
}): string {
  const head = `${OFFLINE_METHOD_LABELS[input.method]}${input.reference ? ` · ref ${input.reference}` : ""}`;
  return [
    head,
    `${formatINR(input.totalPaise, { exact: true })} received ${formatDateIST(input.receivedAt)}`,
    `Invoice ${input.invoiceNumber}`,
    `${plural(input.issued, "license")} issued, ${input.updated} updated`,
    `for ${input.legalName}`,
  ].join(" · ");
}

/** "Changed: items, coupon, billing · total ₹4,000.00 → ₹5,898.82 · 1 payment attempt closed" */
export function orderEditAuditDetail(input: { changed: string[]; oldTotal: number; newTotal: number; closed: number }): string {
  const parts = [`Changed: ${input.changed.join(", ")}`];
  if (input.oldTotal !== input.newTotal) {
    parts.push(`total ${formatINR(input.oldTotal, { exact: true })} → ${formatINR(input.newTotal, { exact: true })}`);
  }
  parts.push(`${plural(input.closed, "payment attempt")} closed`);
  return parts.join(" · ");
}

// ---------- Console copy ----------

/** New copy (owner review), docs/admin-records-design.md B11. */
export const ORDER_RECORD_COPY = {
  newOrder: "New order",
  newSubtitle: "Prices come from the catalog. Licenses are issued only after payment.",
  customer: "Customer",
  customerPlaceholder: "Business, name, email or GSTIN",
  customerHint: "Search by business, name, email or GSTIN.",
  customerSelected: (name: string) => `Selected: ${name}`,
  noMatches: "No matching customers.",
  chooseCustomer: "Choose a customer.",
  change: "Change",
  items: "Items",
  plan: "Plan",
  planPlaceholder: "Choose a plan",
  type: "Type",
  forLicense: "For license",
  licensePlaceholder: "Choose a license",
  noLicenses: "This customer has no license for this product.",
  quantity: "Quantity",
  addItem: "Add item",
  removeItem: (n: number) => `Remove item ${n}`,
  choosePlan: "Choose a plan.",
  chooseLicense: "Choose the license this item is for.",
  coupon: "Coupon",
  couponHint: "Optional.",
  billing: "Billing details",
  billingHint: "Printed on the tax invoice.",
  billingName: "Full name",
  billingEmail: "Email",
  billingPhone: "Mobile",
  billingBusiness: "Business name",
  billingGstin: "GSTIN",
  billingAddress: "Address",
  billingCity: "City",
  billingState: "State",
  billingStatePlaceholder: "Choose a state",
  billingPin: "PIN code",
  summary: "Summary",
  summaryNote: "Prices come from the catalog, exactly as at checkout.",
  updating: "Updating…",
  summaryEmptyNew: "Choose a customer and a plan to see the total.",
  summaryEmptyEdit: "Choose a plan to see the total.",
  quoteFailed: "We couldn’t price these items. Check the items and try again.",
  subtotal: "Subtotal",
  discount: "Discount",
  taxable: "Taxable value",
  total: "Total",
  howPay: "How will they pay?",
  modeLink: "Send a payment link",
  modeLinkHint: "They pay online. Licenses are issued when the payment is confirmed.",
  modeOffline: "Record a payment we’ve received",
  modeOfflineHint: "Cash, UPI, bank transfer or cheque. Licenses and the tax invoice are issued now.",
  method: "Method",
  reference: "UTR or reference",
  chequeNo: "Cheque number",
  receivedOn: "Received on",
  amount: "Amount received (₹)",
  amountHint: (total: string) => `Must equal the order total, ${total}. Partial payments can’t be recorded.`,
  amountInvalid: "Enter the amount in rupees, like 5898.82.",
  reason: "Reason (saved to the audit log)",
  createOrder: "Create order",
  recordPayment: "Record payment",
  confirmTitle: (total: string) => `Record ${total} and issue licenses?`,
  confirmBody:
    "This marks the order paid, issues its licenses and tax invoice now, and emails the customer. It can’t be undone in the console.",
  created: (id: string) => `Order ${id} created`,
  linkLabel: "Payment link",
  copyLink: "Copy link",
  copied: "Link copied",
  copyFailed: "Couldn’t copy the link. Select it and copy it instead.",
  linkEmailed: (email: string) => `We’ll email it to ${email}. The link works for ${PAYMENT_LINK_DAYS} days.`,
  linkNote: "This link never shows the license key. Only send it to the customer.",
  openOrder: "Open order",
  createAnother: "Create another",
  offlineDone: (id: string, invoice: string, n: number) => `${id} paid · Invoice ${invoice} · ${plural(n, "license")} issued`,
  editTitle: "Edit order",
  editReadOnly: "Your role can’t edit orders.",
  editRolesNote: "Owner and Finance can change the items, coupon and billing of unpaid orders.",
  saveChanges: "Save changes",
  updated: "Order updated",
  noChanges: "No changes to save",
  paymentLink: "Payment link",
  paymentLinkTitle: (id: string) => `Payment link for ${id}`,
  paymentLinkBody: "Share this link with the customer. They check the order and pay online.",
  emailIt: (email: string) => `Email it to ${email}`,
  linkEmailedToast: "Payment link emailed",
  cancelConsequence: "The customer can’t pay this order any more, and open payment pages stop working. Nothing was charged.",
  canceled: "Order cancelled",
  correctBilling: "Correct billing",
  correctTitle: (id: string) => `Correct billing details for ${id}`,
  correctLockedHint: "The state sets the GST split, so it can’t change.",
  correctConsequence: (invoice: string) =>
    `We’ll issue a credit note that cancels invoice ${invoice} in full and a new invoice with these details. Amounts, licenses and the payment don’t change.`,
  correctConfirm: "Issue corrected invoice",
  corrected: (cn: string, inv: string) => `Credit note ${cn} and invoice ${inv} issued`,
  resendSuggestion: "Send the customer the new invoice with “Resend invoice”.",
  correctionsTitle: "Invoice corrections",
  correctionRow: (cn: string, orig: string, date: string, inv: string) => `${cn} cancels ${orig} (${date}) → ${inv}`,
  creditNotePdf: "Credit note PDF",
  createdBy: "Created by",
  staffSuffix: (name: string) => `${name} (staff)`,
  canceledByStaff: "Cancelled by staff",
  offlinePayment: (method: string, reference: string | null, received: string | null, by: string | null) =>
    [method, reference ? `ref ${reference}` : null, received ? `received ${received}` : null, by ? `recorded by ${by}` : null]
      .filter(Boolean)
      .join(" · "),
} as const;

export const OFFLINE_METHOD_OPTIONS = OFFLINE_METHODS.map((value) => ({ value, label: OFFLINE_METHOD_LABELS[value] }));
