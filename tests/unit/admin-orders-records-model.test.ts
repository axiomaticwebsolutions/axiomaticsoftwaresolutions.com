/**
 * Admin records PART B (docs/admin-records-design.md B12, unit): the order request bodies, the paid-order billing
 * correction rules (state and email locked, other-state GSTINs refused, the GST split unchanged), the offline payment
 * date window in IST, the order state rules, the form helpers and the audit wording; the credit-note document model;
 * the order page for orders our team prepared or cancelled; the provider and method labels.
 */
import { describe, expect, it } from "vitest";
import { heroActions, heroFor, invoiceInputFrom, orderPaths } from "@/components/store/order/order-model";
import {
  OFFLINE_METHOD_LABELS,
  ORDER_METHOD_FILTERS,
  ORDER_METHOD_LABELS,
  ORDER_PROVIDER_FILTERS,
  PROVIDER_LABELS,
  providerLabel,
} from "@/lib/admin/orders/model";
import { correctedBilling } from "@/lib/admin/orders/correction-rules";
import {
  changedBillingFields,
  earliestReceivedOn,
  emptyOrderDraft,
  istToday,
  kindsForPlanType,
  lineHasQuantity,
  lineNeedsTarget,
  offlineAuditDetail,
  ORDER_RECORD_MESSAGES,
  orderCorrectionState,
  orderEditAuditDetail,
  orderEditState,
  orderFormErrors,
  orderItemsPayload,
  orderLockError,
  paymentLinkAllowed,
  paymentLinkAuditDetail,
  receivedOnIssue,
  rupeesToPaise,
  type AdminOrderPlanOption,
} from "@/lib/admin/orders/records-model";
import { billingCorrectionBody, offlineOrderBody, orderCreateBody, orderPatchBody, orderQuoteBody } from "@/lib/admin/orders/schemas";
import { buildInvoiceModel, documentFileName, invoiceFileName, type InvoiceModelInput } from "@/lib/invoice/model";
import type { BillingSnapshot } from "@/lib/orders/billing";
import type { OrderStatusDto } from "@/lib/orders/status";
import { offlineProviderOrderId, OFFLINE_PROVIDER } from "@/lib/payments/types";
import { quote, type PricingPlan } from "@/lib/pricing";

const UUID = "3f0b6c1e-2a4d-4c8e-9b7a-1d2e3f4a5b6c";
const BILLING = {
  name: "Priya Sharma",
  email: "priya@sharmamedicals.example",
  phone: "9820000000",
  business: "Sharma Medicals",
  address: "Shop 4, MG Road",
  city: "Pune",
  state: "Maharashtra",
  pin: "411004",
};
const base = { requestId: UUID, accountId: "acct_1", items: [{ planId: "plan-annual", qty: 1 }], billing: BILLING, reason: "Phone order" };

function fieldErrors(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) out[issue.path.map(String).join(".") || "_form"] ??= issue.message;
  return out;
}

describe("request bodies", () => {
  it("create: a uuid request id, 1 to 50 items, checkout's billing rules, strict keys", () => {
    expect(orderCreateBody.safeParse(base).success).toBe(true);
    expect(Object.keys(fieldErrors(orderCreateBody.safeParse({ ...base, requestId: "abc" })))).toEqual(["requestId"]);
    expect(Object.keys(fieldErrors(orderCreateBody.safeParse({ ...base, items: [] })))).toEqual(["items"]);
    const many = Array.from({ length: 51 }, () => ({ planId: "plan-annual", qty: 1 }));
    expect(Object.keys(fieldErrors(orderCreateBody.safeParse({ ...base, items: many })))).toEqual(["items"]);
    expect(Object.keys(fieldErrors(orderCreateBody.safeParse({ ...base, amountPaise: 1 })))).toEqual(["_form"]);
    const parsed = orderCreateBody.parse({ ...base, couponCode: " diwali10 ", billing: { ...BILLING, email: " Priya@SharmaMedicals.Example ", gstin: "27abcde1234f1z5" } });
    expect([parsed.couponCode, parsed.billing.email, parsed.billing.gstin]).toEqual(["DIWALI10", "priya@sharmamedicals.example", "27ABCDE1234F1Z5"]);
    expect(Object.keys(fieldErrors(orderCreateBody.safeParse({ ...base, billing: { ...BILLING, gstin: "29ABCDE1234F1Z5" } })))).toEqual(["billing.gstin"]);
  });

  it("offline: method, references for UPI / bank transfer / cheque, an ISO date and an integer amount", () => {
    const offline = { ...base, method: "cash", receivedOn: "2026-10-07", amountPaise: 589_882 };
    expect(offlineOrderBody.parse(offline).reference).toBeNull();
    expect(fieldErrors(offlineOrderBody.safeParse({ ...offline, method: "upi" }))).toEqual({ reference: ORDER_RECORD_MESSAGES.referenceRequired });
    expect(fieldErrors(offlineOrderBody.safeParse({ ...offline, method: "bank_transfer", reference: "  " }))).toEqual({ reference: ORDER_RECORD_MESSAGES.referenceRequired });
    expect(fieldErrors(offlineOrderBody.safeParse({ ...offline, method: "cheque" }))).toEqual({ reference: ORDER_RECORD_MESSAGES.chequeRequired });
    expect(offlineOrderBody.parse({ ...offline, method: "upi", reference: " UTR 4211/0098 " }).reference).toBe("UTR 4211/0098");
    expect(Object.keys(fieldErrors(offlineOrderBody.safeParse({ ...offline, reference: "UTR<script>" })))).toEqual(["reference"]);
    expect(Object.keys(fieldErrors(offlineOrderBody.safeParse({ ...offline, method: "crypto" })))).toEqual(["method"]);
    expect(Object.keys(fieldErrors(offlineOrderBody.safeParse({ ...offline, receivedOn: "07/10/2026" })))).toEqual(["receivedOn"]);
    for (const amountPaise of [0, -5, 12.5, "100"]) {
      expect(Object.keys(fieldErrors(offlineOrderBody.safeParse({ ...offline, amountPaise }))), String(amountPaise)).toEqual(["amountPaise"]);
    }
  });

  it("quote needs exactly one of a customer and an order; patch needs a change; correction takes raw billing strings", () => {
    expect(orderQuoteBody.safeParse({ accountId: "acct_1", items: [] }).success).toBe(true);
    expect(orderQuoteBody.safeParse({ orderId: "AX-10312", items: [] }).success).toBe(true);
    expect(fieldErrors(orderQuoteBody.safeParse({ items: [] }))).toEqual({ _form: ORDER_RECORD_MESSAGES.quoteTarget });
    expect(fieldErrors(orderQuoteBody.safeParse({ accountId: "a", orderId: "AX-1", items: [] }))).toEqual({ _form: ORDER_RECORD_MESSAGES.quoteTarget });
    expect(fieldErrors(orderPatchBody.safeParse({ reason: "x" }))).toEqual({ _form: ORDER_RECORD_MESSAGES.nothingToUpdate });
    expect(orderPatchBody.parse({ couponCode: null, reason: "x" }).couponCode).toBeNull();
    expect(billingCorrectionBody.parse({ billing: { gstin: "27abcde1234f1z5" }, reason: "x" }).billing.gstin).toBe("27abcde1234f1z5");
    expect(billingCorrectionBody.safeParse({ billing: { country: "IN" } }).success).toBe(false);
  });
});

const STORED: BillingSnapshot = { ...BILLING, gstin: null };
const SELLER = { legalName: "Axiomatic", gstin: "27AAAAA0000A1Z5", address: "A", city: "Pune", state: "Maharashtra", pin: "411001", sample: false };

describe("correctedBilling (paid orders)", () => {
  it("locks the state and the email", () => {
    expect(correctedBilling(STORED, { state: "Karnataka" })).toEqual({ ok: false, fieldErrors: { "billing.state": ORDER_RECORD_MESSAGES.stateLocked } });
    expect(correctedBilling(STORED, { email: "other@example.test" })).toEqual({ ok: false, fieldErrors: { "billing.email": ORDER_RECORD_MESSAGES.emailLocked } });
    // The same values (any case or spacing for the email) are fine.
    expect(correctedBilling(STORED, { state: "Maharashtra", email: " Priya@SharmaMedicals.example ", city: "Pimpri" })).toMatchObject({ ok: true, changedFields: ["city"] });
  });

  it("refuses a GSTIN from another state and allows one from the same state", () => {
    const other = correctedBilling(STORED, { gstin: "29ABCDE1234F1Z5" });
    expect(other.ok).toBe(false);
    expect(!other.ok && other.fieldErrors["billing.gstin"]).toBe(
      "This GSTIN is registered in Karnataka. Choose Karnataka as the billing state or check the GSTIN. The billing state can’t change on a paid order.",
    );
    const same = correctedBilling(STORED, { gstin: "27abcde1234f1z5" });
    expect(same).toMatchObject({ ok: true, changedFields: ["gstin"], billing: { gstin: "27ABCDE1234F1Z5", state: "Maharashtra" } });
  });

  it("detects a no-op and names changed fields only", () => {
    expect(correctedBilling(STORED, {})).toMatchObject({ ok: true, changedFields: [] });
    expect(correctedBilling(STORED, { name: "  Priya   Sharma ", phone: "+91 98200 00000" })).toMatchObject({ ok: true, changedFields: [] });
    const r = correctedBilling(STORED, { name: "Priya S", business: "", address: "Unit 7", pin: "411001" });
    expect(r).toMatchObject({ ok: true, changedFields: ["name", "business", "address", "pin"] });
    expect(r.ok && r.billing.business).toBeNull();
    expect(correctedBilling(STORED, { pin: "12" })).toMatchObject({ ok: false, fieldErrors: { "billing.pin": expect.any(String) } });
  });

  it("never changes the GST split: the place of supply stays the order's", () => {
    const plans = new Map<string, PricingPlan>([["p1", { id: "p1", productId: "prod", type: "ANNUAL", pricePaise: 499_900, perUnit: null, maxQty: null }]]);
    const priced = (state: string) => quote({ lines: [{ planId: "p1", qty: 1 }], plans, tax: { gstRatePct: 18, companyState: "Maharashtra" }, billingState: state, now: new Date() });
    const patches = [{ gstin: "27ABCDE1234F1Z5" }, { address: "Unit 9", city: "Nashik" }, { business: "", name: "P S" }, { phone: "9999999999" }];
    for (const stored of [STORED, { ...STORED, state: "Karnataka" }]) {
      const before = priced(stored.state);
      for (const patch of patches) {
        const r = correctedBilling(stored, patch.gstin && stored.state === "Karnataka" ? { gstin: "29ABCDE1234F1Z5" } : patch);
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        const after = priced(r.billing.state);
        expect([after.cgstPaise, after.sgstPaise, after.igstPaise, after.totalPaise]).toEqual([before.cgstPaise, before.sgstPaise, before.igstPaise, before.totalPaise]);
      }
    }
  });
});

describe("offline received date (IST)", () => {
  it("accepts today back to 180 days and refuses the future and older dates, at IST day boundaries", () => {
    // 8 Oct 2026, 00:10 IST (still 7 Oct in UTC).
    const now = new Date("2026-10-07T18:40:00.000Z");
    expect(istToday(now)).toBe("2026-10-08");
    expect(receivedOnIssue("2026-10-08", now)).toBeNull();
    expect(receivedOnIssue("2026-10-09", now)).toBe(ORDER_RECORD_MESSAGES.receivedOn);
    expect(earliestReceivedOn(now)).toBe("2026-04-11");
    expect(receivedOnIssue("2026-04-11", now)).toBeNull();
    expect(receivedOnIssue("2026-04-10", now)).toBe(ORDER_RECORD_MESSAGES.receivedOn);
    expect(receivedOnIssue("2026-13-01x", now)).toBe(ORDER_RECORD_MESSAGES.receivedOn);
    // 7 Oct 2026, 23:50 IST: tomorrow (8 Oct) is still the future.
    expect(receivedOnIssue("2026-10-08", new Date("2026-10-07T18:20:00.000Z"))).toBe(ORDER_RECORD_MESSAGES.receivedOn);
  });
});

describe("order state rules", () => {
  const order = (status: string, over: { canceledByStaffAt?: Date | null; payments?: { status: string }[] } = {}) => ({
    status,
    canceledByStaffAt: over.canceledByStaffAt ?? null,
    payments: over.payments ?? [],
  });

  it("edits and cancels unpaid orders only, never while a payment settles or after a staff cancel", () => {
    for (const status of ["AWAITING_PAYMENT", "FAILED", "CANCELED"]) {
      expect(orderEditState(order(status))).toEqual({ allowed: true, reason: null });
      expect(orderLockError(order(status), "edit")).toBeNull();
      expect(paymentLinkAllowed(order(status))).toBe(true);
    }
    expect(orderLockError(order("PAID"), "edit")?.code).toBe("not_editable");
    expect(orderLockError(order("REFUNDED"), "cancel")?.code).toBe("not_cancelable");
    for (const status of ["PENDING", "CONFIRMING", "REVIEW"]) expect(orderLockError(order(status), "edit")?.code).toBe("payment_in_progress");
    expect(orderLockError(order("AWAITING_PAYMENT", { payments: [{ status: "AUTHORIZED" }] }), "cancel")?.code).toBe("payment_in_progress");
    const cancelled = order("CANCELED", { canceledByStaffAt: new Date() });
    expect(orderLockError(cancelled, "edit")?.code).toBe("order_canceled");
    expect(orderLockError(cancelled, "cancel")).toBeNull();
    expect(paymentLinkAllowed(cancelled)).toBe(false);
    expect(orderEditState(cancelled).reason).toBe("This order was cancelled by our team.");
    expect(orderEditState(order("PAID")).reason).toBe("Paid orders keep their items and amounts.");
  });

  it("corrects paid orders with an invoice and no refunds; hides the action for unpaid orders", () => {
    expect(orderCorrectionState({ status: "PAID", hasInvoice: true, refunds: [] })).toEqual({ allowed: true, reason: null });
    expect(orderCorrectionState({ status: "PAID", hasInvoice: true, refunds: [{ status: "FAILED" }] }).allowed).toBe(true);
    expect(orderCorrectionState({ status: "PAID", hasInvoice: true, refunds: [{ status: "PENDING" }] })).toEqual({ allowed: false, reason: ORDER_RECORD_MESSAGES.notCorrectable });
    expect(orderCorrectionState({ status: "PARTIALLY_REFUNDED", hasInvoice: true, refunds: [] }).allowed).toBe(false);
    expect(orderCorrectionState({ status: "PAID", hasInvoice: false, refunds: [] }).allowed).toBe(false);
    expect(orderCorrectionState({ status: "AWAITING_PAYMENT", hasInvoice: false, refunds: [] })).toEqual({ allowed: false, reason: null });
  });
});

describe("form helpers", () => {
  const plans: AdminOrderPlanOption[] = [
    { id: "annual", productId: "med", productName: "Medical", planName: "Annual", type: "ANNUAL", pricePaise: 499_900, perUnit: null, maxQty: null, productPublished: true },
    { id: "terminal", productId: "med", productName: "Medical", planName: "Per terminal", type: "ANNUAL", pricePaise: 299_900, perUnit: "terminal", maxQty: 5, productPublished: true },
    { id: "addon", productId: "med", productName: "Medical", planName: "Extra PC", type: "DEVICE_ADDON", pricePaise: 99_900, perUnit: null, maxQty: null, productPublished: true },
  ];

  it("kinds, targets and quantities follow the pricing rules", () => {
    expect(kindsForPlanType("ANNUAL")).toEqual(["NEW", "RENEWAL", "UPGRADE"]);
    expect(kindsForPlanType("DEVICE_ADDON")).toEqual(["ADDON"]);
    expect(kindsForPlanType("MAINTENANCE")).toEqual(["RENEWAL"]);
    expect([lineNeedsTarget("NEW", "ANNUAL"), lineNeedsTarget("RENEWAL", "ANNUAL"), lineNeedsTarget("NEW", "MAINTENANCE")]).toEqual([false, true, true]);
    expect([lineHasQuantity(plans[0] as AdminOrderPlanOption, "NEW"), lineHasQuantity(plans[1] as AdminOrderPlanOption, "NEW"), lineHasQuantity(plans[2] as AdminOrderPlanOption, "ADDON")]).toEqual([false, true, true]);
  });

  it("builds the items payload and checks the draft before sending", () => {
    const now = new Date("2026-10-07T06:30:00.000Z");
    const draft = emptyOrderDraft(istToday(now));
    draft.lines = [
      { key: "a", planId: "annual", kind: "NEW", targetLicenseId: "LIC-1", qty: "3" },
      { key: "b", planId: "terminal", kind: "RENEWAL", targetLicenseId: "", qty: "9" },
      { key: "c", planId: "legacy-plan", kind: "RENEWAL", targetLicenseId: "LIC-2", qty: "1" },
      { key: "d", planId: "", kind: "NEW", targetLicenseId: "", qty: "1" },
    ];
    expect(orderItemsPayload(draft.lines, plans)).toEqual([
      { planId: "annual", qty: 1, kind: "NEW", targetLicenseId: null },
      { planId: "terminal", qty: 9, kind: "RENEWAL", targetLicenseId: null },
      { planId: "legacy-plan", qty: 1, kind: "RENEWAL", targetLicenseId: "LIC-2" },
    ]);
    draft.mode = "offline";
    draft.method = "upi";
    draft.amount = "5,898.8";
    const errors = orderFormErrors(draft, plans, { needCustomer: true, hasCustomer: false, payment: true, now });
    expect(Object.keys(errors).sort()).toEqual(["accountId", "items.1.qty", "items.1.targetLicenseId", "items.3.planId", "reason", "reference"].sort());
    expect(rupeesToPaise("₹5,898.82")).toBe(589_882);
    expect(rupeesToPaise("5898.8")).toBe(589_880);
    expect(rupeesToPaise("5898")).toBe(589_800);
    expect([rupeesToPaise("5898.825"), rupeesToPaise("abc"), rupeesToPaise("")]).toEqual([null, null, null]);
  });

  it("audit wording names fields and amounts, never secrets", () => {
    expect(paymentLinkAuditDetail({ totalPaise: 589_882, items: 2, couponCode: "DIWALI10", legalName: "Sharma Medicals" })).toBe(
      "Payment link · ₹5,898.82 · 2 items · coupon DIWALI10 · for Sharma Medicals",
    );
    expect(
      offlineAuditDetail({ method: "bank_transfer", reference: "UTR1", totalPaise: 589_882, receivedAt: new Date("2026-10-06T18:30:00.000Z"), invoiceNumber: "AXS/26-27/0007", issued: 1, updated: 0, legalName: "Sharma Medicals" }),
    ).toBe("Bank transfer · ref UTR1 · ₹5,898.82 received 7 Oct 2026 · Invoice AXS/26-27/0007 · 1 license issued, 0 updated · for Sharma Medicals");
    expect(orderEditAuditDetail({ changed: ["items", "coupon"], oldTotal: 100_000, newTotal: 200_000, closed: 1 })).toBe(
      "Changed: items, coupon · total ₹1,000.00 → ₹2,000.00 · 1 payment attempt closed",
    );
    expect(changedBillingFields({ ...STORED }, { ...STORED, gstin: "27ABCDE1234F1Z5", city: "Nashik" })).toEqual(["city", "gstin"]);
  });
});

describe("credit note and corrected invoice documents", () => {
  const input = (over: Partial<InvoiceModelInput> = {}): InvoiceModelInput => ({
    orderId: "AX-10301",
    status: "PAID",
    createdAt: "2026-10-06T22:32:00.000Z",
    invoice: { number: "AXC/26-27/0004", issuedAt: "2026-10-08T06:30:00.000Z" },
    sac: "997331",
    seller: SELLER,
    billing: { ...STORED },
    placeOfSupply: "Maharashtra",
    couponCode: null,
    totals: { subtotalPaise: 999_800, discountPaise: 0, taxablePaise: 999_800, cgstPaise: 89_982, sgstPaise: 89_982, igstPaise: 0, totalPaise: 1_179_764 },
    items: [
      { productName: "Medical", planName: "Annual", kind: "NEW", qty: 1, unitPricePaise: 499_900, discountPaise: 0, taxablePaise: 499_900, taxPaise: 89_982, targetLicenseId: null },
      { productName: "Medical", planName: "Annual", kind: "RENEWAL", qty: 1, unitPricePaise: 499_900, discountPaise: 0, taxablePaise: 499_900, taxPaise: 89_982, targetLicenseId: "LIC-1" },
    ],
    ...over,
  });

  it("builds a credit note with the invoice's totals and line split, its own labels and the cancelled invoice", () => {
    const invoice = buildInvoiceModel(input({ invoice: { number: "AXS/26-27/0012", issuedAt: "2026-10-07T06:30:00.000Z" } }));
    const note = buildInvoiceModel(
      input({ document: { kind: "credit_note", against: { number: "AXS/26-27/0012", issuedAt: "2026-10-07T06:30:00.000Z" }, replacedBy: "AXS/26-27/0015" } }),
    );
    expect(note).toMatchObject({
      kind: "credit_note",
      docLabel: "Credit note",
      numberLabel: "CREDIT NOTE NO.",
      dateLabel: "DATE",
      title: "Credit note AXC/26-27/0004",
      totalLabel: "Total credited",
      reference: { label: "AGAINST INVOICE", value: "AXS/26-27/0012 · 7 Oct 2026" },
      extraNotes: [
        "Issued to cancel tax invoice AXS/26-27/0012 dated 7 Oct 2026 in full because the billing details were corrected.",
        "Replaced by tax invoice AXS/26-27/0015.",
      ],
      amountInWords: invoice.amountInWords,
      totalPaise: invoice.totalPaise,
    });
    expect(note.totals.map((t) => t.paise)).toEqual(invoice.totals.map((t) => t.paise));
    expect(note.lines.map((l) => [l.cgstPaise, l.sgstPaise])).toEqual(invoice.lines.map((l) => [l.cgstPaise, l.sgstPaise]));
    expect(invoice).toMatchObject({ kind: "invoice", docLabel: "Tax invoice", numberLabel: "INVOICE NO.", dateLabel: "INVOICE DATE", reference: null, extraNotes: [] });
  });

  it("notes what a corrected invoice replaces, and names the files", () => {
    const corrected = buildInvoiceModel(
      input({ invoice: { number: "AXS/26-27/0015", issuedAt: "2026-10-08T06:30:00.000Z" }, document: { kind: "invoice", replaces: { invoiceNo: "AXS/26-27/0012", creditNoteNo: "AXC/26-27/0004" } } }),
    );
    expect(corrected.extraNotes).toEqual(["This invoice replaces AXS/26-27/0012, cancelled by credit note AXC/26-27/0004 (billing details corrected)."]);
    expect(documentFileName("credit_note", "AXC/26-27/0004")).toBe("CreditNote-AXC-26-27-0004.pdf");
    expect(documentFileName("invoice", "AXS/26-27/0012")).toBe("Invoice-AXS-26-27-0012.pdf");
    expect(invoiceFileName("AXS/26-27/0012")).toBe("Invoice-AXS-26-27-0012.pdf");
  });
});

describe("order page for orders our team prepared or cancelled", () => {
  const dto = (over: Partial<OrderStatusDto>): Pick<OrderStatusDto, "status" | "email" | "failReason" | "licenses" | "canRetry" | "invoice" | "placedByStaff" | "canceledByStaff"> => ({
    status: "AWAITING_PAYMENT",
    email: "priya@sharmamedicals.example",
    failReason: null,
    licenses: [],
    canRetry: true,
    invoice: null,
    placedByStaff: true,
    canceledByStaff: false,
    ...over,
  });
  const links = { invoicePdf: "/x" };

  it("reads 'Ready for payment' with Pay now and Contact support (no cart)", () => {
    expect(heroFor(dto({}))).toMatchObject({ tone: "blue", icon: "receipt_long", title: "Ready for payment" });
    expect(heroActions(dto({}), links).map((a) => a.label)).toEqual(["Pay now", "Contact support"]);
    expect(heroActions(dto({ status: "FAILED" }), links).map((a) => a.label)).toEqual(["Try again", "Contact support"]);
    expect(heroActions(dto({ canRetry: false }), links).map((a) => a.label)).toEqual(["Contact support"]);
  });

  it("reads 'Order cancelled' with Contact support only after a staff cancel", () => {
    const cancelled = dto({ status: "CANCELED", canceledByStaff: true, canRetry: false });
    expect(heroFor(cancelled)).toMatchObject({ tone: "slate", icon: "cancel", title: "Order cancelled" });
    expect(heroActions(cancelled, links).map((a) => a.label)).toEqual(["Contact support"]);
    // Checkout orders are unchanged.
    expect(heroActions(dto({ placedByStaff: false }), links).map((a) => a.label)).toEqual(["Return to payment", "Edit order"]);
  });

  it("links credit notes with the order token and passes the replaced invoice to the invoice model", () => {
    expect(orderPaths("AX-1", "tok").creditNotePdf("cn_1")).toBe("/api/orders/AX-1/credit-notes/cn_1?t=tok");
    expect(orderPaths("AX-1", null).creditNotePdf("cn_1")).toBe("/api/orders/AX-1/credit-notes/cn_1");
    const full = {
      id: "AX-1",
      status: "PAID",
      failReason: null,
      createdAt: "2026-10-06T22:32:00.000Z",
      paidAt: "2026-10-06T22:33:00.000Z",
      email: STORED.email,
      billing: STORED,
      placeOfSupply: "Maharashtra",
      couponCode: null,
      totals: { subtotalPaise: 0, discountPaise: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0 },
      items: [],
      invoice: { number: "AXS/26-27/0015", issuedAt: "2026-10-08T06:30:00.000Z", replaces: { invoiceNo: "AXS/26-27/0012", creditNoteNo: "AXC/26-27/0004" } },
      creditNotes: [],
      placedByStaff: false,
      canceledByStaff: false,
      termsRequired: false,
      licenses: [],
      canRetry: false,
      canClaim: false,
      provider: "offline",
    } satisfies OrderStatusDto;
    const model = buildInvoiceModel(invoiceInputFrom(full, { products: {}, seller: SELLER, sac: "997331", fallbackGstRatePct: 18 }));
    expect(model.extraNotes[0]).toContain("replaces AXS/26-27/0012");
  });
});

describe("labels", () => {
  it("lists offline payments as a provider and the offline methods as method filters", () => {
    expect(ORDER_PROVIDER_FILTERS).toEqual(["razorpay", "cashfree", "mock", "offline"]);
    expect(PROVIDER_LABELS.offline).toBe("Offline");
    expect(providerLabel(OFFLINE_PROVIDER, true)).toBe("Offline");
    expect(providerLabel("mock", false)).toBe("Mock (test)");
    expect(ORDER_METHOD_FILTERS).toEqual(["upi", "card", "netbanking", "cash", "bank_transfer", "cheque", "other"]);
    expect(ORDER_METHOD_FILTERS.map((m) => ORDER_METHOD_LABELS[m])).toEqual(["UPI", "Card", "Net banking", "Cash", "Bank transfer", "Cheque", "Other"]);
    expect(OFFLINE_METHOD_LABELS).toEqual({ cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", cheque: "Cheque", other: "Other" });
    expect(offlineProviderOrderId("AX-10312")).toBe("offline:AX-10312");
  });
});
