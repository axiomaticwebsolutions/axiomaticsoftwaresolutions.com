import { describe, expect, it } from "vitest";
import {
  normalizeRazorpayPayment,
  normalizeRazorpayRefund,
  normalizeRazorpayWebhook,
  razorpayMethodLabel,
  RazorpayProvider,
  signRazorpayWebhook,
} from "@/lib/payments/razorpay";
import { PaymentProviderError } from "@/lib/payments/types";

// Realistic payloads in the shape Razorpay documents, including the instrument and contact fields that must never
// survive normalization.
const CREATED_AT = 1_767_000_000;
const EVENT_AT = 1_767_000_006;

const cardPayment = {
  id: "pay_DESlfW9H8K9uqM",
  entity: "payment",
  amount: 589_882,
  currency: "INR",
  base_amount: 589_882,
  status: "captured",
  order_id: "order_DESlLckIVRkHWj",
  invoice_id: null,
  international: false,
  method: "card",
  amount_refunded: 0,
  refund_status: null,
  captured: true,
  description: "Order AX-10312",
  card_id: "card_DESlfW9H8K9uqN",
  card: { id: "card_DESlfW9H8K9uqN", entity: "card", name: "Priya Sharma", last4: "1111", network: "Visa", type: "debit", issuer: "HDFC", international: false, emi: false },
  bank: null,
  wallet: null,
  vpa: null,
  email: "priya@sharmamedicals.example",
  contact: "+919820000000",
  notes: { orderId: "AX-10312" },
  fee: 11_798,
  tax: 1_800,
  error_code: null,
  error_description: null,
  error_source: null,
  error_step: null,
  error_reason: null,
  acquirer_data: { auth_code: "828553" },
  created_at: CREATED_AT,
};

const failedUpiPayment = {
  ...cardPayment,
  id: "pay_FailUpi0000001",
  status: "failed",
  order_id: "order_FailUpi000001",
  method: "upi",
  captured: false,
  card_id: null,
  card: undefined,
  vpa: "priya@okhdfcbank",
  error_code: "BAD_REQUEST_ERROR",
  error_description: "Payment was unsuccessful as you may have typed the wrong UPI PIN.",
  error_source: "customer",
  error_step: "payment_authentication",
  error_reason: "incorrect_pin",
  acquirer_data: { rrn: "300012345678" },
};

const envelope = (event: string, payload: Record<string, unknown>) => ({
  entity: "event",
  account_id: "acc_BFQ7uQEaa7j2z7",
  event,
  contains: Object.keys(payload),
  payload,
  created_at: EVENT_AT,
});

const capturedBody = envelope("payment.captured", { payment: { entity: cardPayment } });
const failedBody = envelope("payment.failed", { payment: { entity: failedUpiPayment } });
const orderEntity = {
  id: "order_DESlLckIVRkHWj",
  entity: "order",
  amount: 589_882,
  amount_paid: 589_882,
  amount_due: 0,
  currency: "INR",
  receipt: "AX-10312",
  offer_id: null,
  status: "paid",
  attempts: 1,
  notes: { orderId: "AX-10312" },
  created_at: CREATED_AT - 60,
};
const orderPaidBody = envelope("order.paid", { payment: { entity: cardPayment }, order: { entity: orderEntity } });
const refundEntity = {
  id: "rfnd_FP8DDKxqJif6ca",
  entity: "refund",
  amount: 300_000,
  currency: "INR",
  payment_id: "pay_DESlfW9H8K9uqM",
  notes: { reason: "Customer request" },
  receipt: null,
  acquirer_data: { arn: "74287470000000000000000" },
  created_at: EVENT_AT - 3,
  batch_id: null,
  status: "processed",
  speed_processed: "normal",
  speed_requested: "normal",
};
const refundedPayment = { ...cardPayment, amount_refunded: 300_000, refund_status: "partial" };
const refundBody = envelope("refund.processed", { refund: { entity: refundEntity }, payment: { entity: refundedPayment } });

const SECRETS = ["1111", "828553", "priya@", "9820000000", "okhdfcbank", "Priya Sharma", "74287470000000000000000", "300012345678", "HDFC"];

function expectNoInstrumentData(value: unknown): void {
  const text = JSON.stringify(value);
  for (const s of SECRETS) expect(text).not.toContain(s);
}

describe("normalizeRazorpayWebhook", () => {
  it("maps payment.captured to ids, amount in paise, currency, a method label and the event time", () => {
    const result = normalizeRazorpayWebhook(capturedBody, "evt_KJbBp9eW6xBpGr");
    expect(result).toEqual({
      ok: true,
      event: {
        id: "evt_KJbBp9eW6xBpGr",
        type: "payment.captured",
        providerOrderId: "order_DESlLckIVRkHWj",
        providerPaymentId: "pay_DESlfW9H8K9uqM",
        amountPaise: 589_882,
        currency: "INR",
        method: "Card",
        occurredAt: new Date(EVENT_AT * 1000),
      },
    });
    expectNoInstrumentData(result);
  });

  it("maps order.paid to payment.captured semantics for the order's captured payment", () => {
    const result = normalizeRazorpayWebhook(orderPaidBody, "evt_OrderPaid000001");
    expect(result).toMatchObject({
      ok: true,
      event: {
        id: "evt_OrderPaid000001",
        type: "payment.captured",
        providerOrderId: "order_DESlLckIVRkHWj",
        providerPaymentId: "pay_DESlfW9H8K9uqM",
        amountPaise: 589_882,
      },
    });
    expectNoInstrumentData(result);
  });

  it("maps payment.failed with the provider's failure description and never the VPA", () => {
    const result = normalizeRazorpayWebhook(failedBody, "evt_Failed00000001");
    expect(result).toEqual({
      ok: true,
      event: {
        id: "evt_Failed00000001",
        type: "payment.failed",
        providerOrderId: "order_FailUpi000001",
        providerPaymentId: "pay_FailUpi0000001",
        amountPaise: 589_882,
        currency: "INR",
        method: "UPI",
        failureReason: "Payment was unsuccessful as you may have typed the wrong UPI PIN.",
        occurredAt: new Date(EVENT_AT * 1000),
      },
    });
    expectNoInstrumentData(result);
  });

  it("maps refund.processed with the refund id and refunded amount", () => {
    const result = normalizeRazorpayWebhook(refundBody, "evt_Refund00000001");
    expect(result).toEqual({
      ok: true,
      event: {
        id: "evt_Refund00000001",
        type: "refund.processed",
        providerOrderId: "order_DESlLckIVRkHWj",
        providerPaymentId: "pay_DESlfW9H8K9uqM",
        providerRefundId: "rfnd_FP8DDKxqJif6ca",
        amountPaise: 300_000,
        currency: "INR",
        occurredAt: new Date(EVENT_AT * 1000),
      },
    });
    expectNoInstrumentData(result);
  });

  it("maps refund.failed like refund.processed (the handler marks the refund FAILED)", () => {
    const failedBody = envelope("refund.failed", { refund: { entity: { ...refundEntity, status: "failed" } }, payment: { entity: refundedPayment } });
    const result = normalizeRazorpayWebhook(failedBody, "evt_Refund00000002");
    expect(result).toMatchObject({
      ok: true,
      event: { id: "evt_Refund00000002", type: "refund.failed", providerRefundId: "rfnd_FP8DDKxqJif6ca", providerOrderId: "order_DESlLckIVRkHWj", amountPaise: 300_000 },
    });
    expectNoInstrumentData(result);
  });

  it("normalizes a refund entity's status for reconciliation", () => {
    for (const [status, expected] of [["processed", "processed"], ["failed", "failed"], ["pending", "pending"], ["created", "pending"]] as const) {
      expect(normalizeRazorpayRefund({ ...refundEntity, status })).toEqual({
        providerRefundId: "rfnd_FP8DDKxqJif6ca",
        providerPaymentId: refundEntity.payment_id,
        status: expected,
        amountPaise: 300_000,
        currency: "INR",
      });
    }
    expect(() => normalizeRazorpayRefund({ id: "x" })).toThrow(PaymentProviderError);
  });

  it("keeps a foreign currency so the handler can refuse it", () => {
    const usd = envelope("payment.captured", { payment: { entity: { ...cardPayment, currency: "USD", amount: 7_000 } } });
    expect(normalizeRazorpayWebhook(usd, "evt_Usd")).toMatchObject({ ok: true, event: { currency: "USD", amountPaise: 7_000 } });
  });

  it("falls back to a stable id when the event id header is missing or malformed", () => {
    expect(normalizeRazorpayWebhook(capturedBody, null)).toMatchObject({ event: { id: "payment.captured:pay_DESlfW9H8K9uqM" } });
    expect(normalizeRazorpayWebhook(capturedBody, "evt with spaces")).toMatchObject({ event: { id: "payment.captured:pay_DESlfW9H8K9uqM" } });
    expect(normalizeRazorpayWebhook(orderPaidBody, null)).toMatchObject({ event: { id: "order.paid:order_DESlLckIVRkHWj" } });
    expect(normalizeRazorpayWebhook(refundBody, "")).toMatchObject({ event: { id: "refund.processed:rfnd_FP8DDKxqJif6ca" } });
  });

  it("answers unsupported_event for events the order state machine ignores", () => {
    for (const event of ["payment.authorized", "refund.created", "refund.speed_changed", "order.notification.delivered"]) {
      expect(normalizeRazorpayWebhook(envelope(event, { payment: { entity: cardPayment } }), "evt_x")).toEqual({
        ok: false,
        reason: "unsupported_event",
        signatureOk: true,
      });
    }
    expect(normalizeRazorpayWebhook({ event: "subscription.charged", payload: "odd" }, "evt_y")).toMatchObject({ reason: "unsupported_event" });
  });

  it("answers invalid_payload for supported events it cannot map", () => {
    const cases: unknown[] = [
      null,
      "payment.captured",
      envelope("payment.captured", {}),
      envelope("payment.captured", { payment: { entity: { ...cardPayment, order_id: null } } }),
      envelope("payment.captured", { payment: { entity: { ...cardPayment, amount: -1 } } }),
      envelope("payment.captured", { payment: { entity: { ...cardPayment, amount: 10.5 } } }),
      envelope("payment.captured", { payment: { entity: { ...cardPayment, id: "pay/../../x" } } }),
      envelope("order.paid", { order: { entity: orderEntity } }),
      envelope("order.paid", { order: { entity: orderEntity }, payment: { entity: { ...cardPayment, order_id: "order_Other0000001" } } }),
      envelope("refund.processed", { refund: { entity: refundEntity } }),
      envelope("refund.processed", { refund: { entity: refundEntity }, payment: { entity: { ...cardPayment, id: "pay_Other00000001" } } }),
    ];
    for (const body of cases) {
      expect(normalizeRazorpayWebhook(body, "evt_z")).toMatchObject({ ok: false, reason: "invalid_payload", signatureOk: true });
    }
  });

  it("verifyWebhook: signed raw body -> normalized event, with the event id from X-Razorpay-Event-Id", () => {
    const secret = "whsec_unit_normalize_0001";
    const provider = new RazorpayProvider({ keyId: "rzp_test_key", keySecret: "rzp_test_secret", webhookSecret: secret });
    const rawBody = JSON.stringify(capturedBody);
    const headers = new Headers({
      "X-Razorpay-Signature": signRazorpayWebhook(rawBody, secret),
      "X-Razorpay-Event-Id": "evt_HeaderId00001",
    });
    expect(provider.verifyWebhook(rawBody, headers)).toMatchObject({ ok: true, event: { id: "evt_HeaderId00001", type: "payment.captured" } });
    const junk = "{not json";
    expect(provider.verifyWebhook(junk, new Headers({ "x-razorpay-signature": signRazorpayWebhook(junk, secret) }))).toEqual({
      ok: false,
      reason: "invalid_payload",
      signatureOk: true,
    });
  });
});

describe("normalizeRazorpayPayment", () => {
  it("maps statuses and keeps only ids, amounts, currency, method label and failure reason", () => {
    expect(normalizeRazorpayPayment(cardPayment)).toEqual({
      providerPaymentId: "pay_DESlfW9H8K9uqM",
      providerOrderId: "order_DESlLckIVRkHWj",
      status: "captured",
      amountPaise: 589_882,
      currency: "INR",
      method: "Card",
    });
    expect(normalizeRazorpayPayment(failedUpiPayment)).toMatchObject({
      status: "failed",
      method: "UPI",
      failureReason: expect.stringContaining("UPI PIN"),
    });
    const statuses = [["created", "created"], ["authorized", "authorized"], ["refunded", "refunded"], ["mystery", "created"]] as const;
    for (const [status, expected] of statuses) expect(normalizeRazorpayPayment({ ...cardPayment, status }).status).toBe(expected);
    expectNoInstrumentData(normalizeRazorpayPayment(failedUpiPayment));
  });

  it("uses the fallback order id and rejects entities it cannot read", () => {
    expect(normalizeRazorpayPayment({ ...cardPayment, order_id: null }, "order_Fallback00001").providerOrderId).toBe("order_Fallback00001");
    expect(() => normalizeRazorpayPayment({ ...cardPayment, order_id: null })).toThrow(PaymentProviderError);
    expect(() => normalizeRazorpayPayment({ id: "pay_x" })).toThrow(PaymentProviderError);
  });

  it("labels methods for display only", () => {
    expect(razorpayMethodLabel("netbanking")).toBe("Net banking");
    expect(razorpayMethodLabel("WALLET")).toBe("Wallet");
    expect(razorpayMethodLabel("crypto")).toBeUndefined();
    expect(razorpayMethodLabel(null)).toBeUndefined();
  });
});
