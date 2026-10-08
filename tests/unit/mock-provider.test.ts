import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { setIntegrationEnvForTests } from "@/lib/integrations/resolver";
import { activePaymentProvider, activePaymentProviderOrNull, getPaymentProvider, PaymentProviderError, resetPaymentProviders } from "@/lib/payments";
import {
  buildMockWebhook,
  mockCapture,
  mockFail,
  MockProvider,
  mockSetRefundStatus,
  resetMockLedger,
  signMockReturn,
  signMockWebhook,
} from "@/lib/payments/mock";
import type { NormalizedEvent } from "@/lib/payments/types";

const keySecret = randomBytes(24).toString("base64url");
const webhookSecret = randomBytes(32).toString("base64url");
const provider = new MockProvider({ keyId: "mock_key_test", keySecret, webhookSecret });
const hex = (secret: string, data: string) => createHmac("sha256", secret).update(data, "utf8").digest("hex");

async function expectProviderError(fn: () => unknown, code: PaymentProviderError["code"]) {
  let error: unknown = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(PaymentProviderError);
  expect((error as PaymentProviderError).code).toBe(code);
}

const captured: Omit<NormalizedEvent, "id" | "currency"> = {
  type: "payment.captured",
  providerOrderId: "order_mock_0123456789abcd",
  providerPaymentId: "pay_mock_0123456789abcd",
  amountPaise: 589_882,
  method: "UPI",
};

beforeEach(() => resetMockLedger());
afterEach(() => {
  setIntegrationEnvForTests(null);
  vi.unstubAllEnvs();
  resetEnvCache();
  resetPaymentProviders();
});

describe("createOrder", () => {
  it("returns a mock provider order id and the dev checkout URL", async () => {
    const { providerOrderId, checkout } = await provider.createOrder({
      orderId: "AX-10312",
      amountPaise: 589_882,
      customer: { email: "priya@example.com" },
    });
    expect(providerOrderId).toMatch(/^order_mock_[0-9a-f]{14}$/);
    expect(checkout).toEqual({ url: `/dev/mock-checkout?order=${providerOrderId}&amount=589882`, keyId: "mock_key_test" });
    expect(await provider.fetchOrderPayments(providerOrderId)).toEqual([]);
  });

  it("rejects non-positive or fractional amounts", async () => {
    for (const amountPaise of [0, -100, 10.5, Number.NaN]) {
      await expectProviderError(
        () => provider.createOrder({ orderId: "AX-1", amountPaise, customer: { email: "a@b.co" } }),
        "invalid_request",
      );
    }
  });
});

describe("verifyReturnSignature", () => {
  const ids = { providerOrderId: "order_mock_aaaaaaaaaaaaaa", providerPaymentId: "pay_mock_bbbbbbbbbbbbbb" };
  const message = `${ids.providerOrderId}|${ids.providerPaymentId}`;

  it("accepts Razorpay's scheme: hex HMAC of orderId|paymentId with the key secret", () => {
    const signature = hex(keySecret, message);
    expect(provider.signReturn(ids.providerOrderId, ids.providerPaymentId)).toBe(signature);
    expect(signMockReturn(ids.providerOrderId, ids.providerPaymentId, keySecret)).toBe(signature);
    expect(provider.verifyReturnSignature({ ...ids, signature })).toBe(true);
  });

  it("rejects tampered ids, other secrets and junk", () => {
    const signature = provider.signReturn(ids.providerOrderId, ids.providerPaymentId);
    const v = (patch: Partial<typeof ids & { signature: string }>) => provider.verifyReturnSignature({ ...ids, signature, ...patch });
    expect(v({ providerPaymentId: "pay_mock_cccccccccccccc" })).toBe(false);
    expect(v({ signature: hex("another-secret-value", message) })).toBe(false);
    expect(v({ signature: signature.toUpperCase() })).toBe(false);
    expect(v({ signature: "" })).toBe(false);
    expect(v({ providerOrderId: "" })).toBe(false);
  });
});

describe("verifyWebhook signatures", () => {
  it("accepts a correctly signed event and returns it normalised", () => {
    const { rawBody, headers, event } = provider.buildWebhook(captured);
    expect(event.id).toMatch(/^evt_mock_[0-9a-f]{14}$/);
    expect(headers.get("x-mock-signature")).toBe(hex(webhookSecret, rawBody));
    expect(provider.verifyWebhook(rawBody, headers)).toEqual({ ok: true, event: { ...captured, id: event.id, currency: "INR" } });
  });

  it("matches the module-level builder and reads the header case-insensitively", () => {
    const { rawBody, headers } = buildMockWebhook({ ...captured, id: "evt_fixed" }, { webhookSecret });
    expect(signMockWebhook(rawBody, webhookSecret)).toBe(headers.get("x-mock-signature"));
    const upper = new Headers({ "X-Mock-Signature": headers.get("x-mock-signature") ?? "" });
    expect(provider.verifyWebhook(rawBody, upper)).toMatchObject({ ok: true, event: { id: "evt_fixed" } });
  });

  it("rejects a tampered body", () => {
    const { rawBody, headers } = provider.buildWebhook(captured);
    const tampered = rawBody.replace("589882", "1");
    expect(tampered).not.toBe(rawBody);
    expect(provider.verifyWebhook(tampered, headers)).toEqual({ ok: false, reason: "invalid_signature", signatureOk: false });
    expect(provider.verifyWebhook(`${rawBody} `, headers)).toMatchObject({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a body signed with the wrong secret", () => {
    const { rawBody, headers } = buildMockWebhook(captured, { webhookSecret: "a-different-webhook-secret" });
    expect(provider.verifyWebhook(rawBody, headers)).toMatchObject({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a missing or empty signature header", () => {
    const { rawBody } = provider.buildWebhook(captured);
    expect(provider.verifyWebhook(rawBody, new Headers())).toEqual({ ok: false, reason: "missing_signature", signatureOk: false });
    expect(provider.verifyWebhook(rawBody, new Headers({ "x-mock-signature": "" }))).toMatchObject({ reason: "missing_signature" });
  });
});

describe("verifyWebhook payloads", () => {
  const signed = (rawBody: string) => new Headers({ "x-mock-signature": hex(webhookSecret, rawBody) });
  const body = (patch: Record<string, unknown>) => JSON.stringify({ ...captured, id: "evt_1", currency: "INR", ...patch });

  it("reports bad payloads with signatureOk true", () => {
    const notJson = "{not json";
    expect(provider.verifyWebhook(notJson, signed(notJson))).toEqual({ ok: false, reason: "invalid_payload", signatureOk: true });
    for (const patch of [{ card: "4111" }, { amountPaise: 10.5 }, { amountPaise: 0 }, { currency: "USD" }, { id: "evt 1" }]) {
      const raw = body(patch);
      expect(provider.verifyWebhook(raw, signed(raw))).toMatchObject({ ok: false, reason: "invalid_payload", signatureOk: true });
    }
    const refundNoId = body({ type: "refund.processed" });
    expect(provider.verifyWebhook(refundNoId, signed(refundNoId))).toMatchObject({ reason: "invalid_payload" });
    const failedNoId = body({ type: "refund.failed" });
    expect(provider.verifyWebhook(failedNoId, signed(failedNoId))).toMatchObject({ reason: "invalid_payload" });
    const noPayment = JSON.stringify({ id: "evt_1", type: "payment.failed", providerOrderId: "order_x", amountPaise: 100, currency: "INR" });
    expect(provider.verifyWebhook(noPayment, signed(noPayment))).toMatchObject({ reason: "invalid_payload" });
  });

  it("refuses oversized bodies before parsing", () => {
    const huge = body({ failureReason: "x".repeat(70_000) });
    expect(provider.verifyWebhook(huge, signed(huge))).toMatchObject({ ok: false, reason: "invalid_payload" });
  });

  it("flags signed events of other types as unsupported", () => {
    const raw = body({ type: "order.paid" });
    expect(provider.verifyWebhook(raw, signed(raw))).toEqual({ ok: false, reason: "unsupported_event", signatureOk: true });
  });

  it("accepts refund.processed with a refund id and payment.failed with a reason", () => {
    const refund = provider.buildWebhook({ ...captured, type: "refund.processed", providerRefundId: "rfnd_mock_1" });
    expect(provider.verifyWebhook(refund.rawBody, refund.headers)).toMatchObject({
      ok: true,
      event: { type: "refund.processed", providerRefundId: "rfnd_mock_1" },
    });
    const refundFailed = provider.buildWebhook({ ...captured, type: "refund.failed", providerRefundId: "rfnd_mock_2" });
    expect(provider.verifyWebhook(refundFailed.rawBody, refundFailed.headers)).toMatchObject({
      ok: true,
      event: { type: "refund.failed", providerRefundId: "rfnd_mock_2" },
    });
    const failed = provider.buildWebhook({ ...captured, type: "payment.failed", failureReason: "Your bank declined the payment." });
    expect(provider.verifyWebhook(failed.rawBody, failed.headers)).toMatchObject({ ok: true, event: { type: "payment.failed" } });
  });
});

describe("ledger", () => {
  it("records failed and captured attempts per provider order", async () => {
    const { providerOrderId } = await provider.createOrder({ orderId: "AX-10313", amountPaise: 50_000, customer: { email: "a@b.co" } });
    const failed = mockFail(providerOrderId, 50_000);
    const paid = mockCapture(providerOrderId, 50_000, "Card");
    expect(failed).toMatchObject({ status: "failed", failureReason: "Your bank declined the payment.", method: "UPI", currency: "INR" });
    expect(paid).toEqual({
      providerPaymentId: expect.stringMatching(/^pay_mock_[0-9a-f]{14}$/),
      providerOrderId,
      status: "captured",
      amountPaise: 50_000,
      currency: "INR",
      method: "Card",
    });
    expect(await provider.fetchPayment(paid.providerPaymentId)).toEqual(paid);
    expect(await provider.fetchOrderPayments(providerOrderId)).toEqual([failed, paid]);
  });

  it("returns copies, so callers cannot edit the ledger", async () => {
    const paid = mockCapture("order_mock_copycheck", 100);
    const fetched = await provider.fetchPayment(paid.providerPaymentId);
    fetched.status = "failed";
    expect((await provider.fetchPayment(paid.providerPaymentId)).status).toBe("captured");
  });

  it("handles unknown payments and orders", async () => {
    await expectProviderError(() => provider.fetchPayment("pay_mock_missing"), "not_found");
    expect(await provider.fetchOrderPayments("order_mock_missing")).toEqual([]);
    expect(() => mockCapture("order_mock_x", 0)).toThrow(PaymentProviderError);
  });

  it("refunds captured payments up to the captured amount", async () => {
    const paid = mockCapture("order_mock_refund", 10_000);
    const first = await provider.refund({ providerPaymentId: paid.providerPaymentId, amountPaise: 4_000, reason: "Customer request" });
    expect(first.providerRefundId).toMatch(/^rfnd_mock_[0-9a-f]{14}$/);
    expect((await provider.fetchPayment(paid.providerPaymentId)).status).toBe("captured");
    await expectProviderError(() => provider.refund({ providerPaymentId: paid.providerPaymentId, amountPaise: 6_001, reason: "x" }), "invalid_request");
    await provider.refund({ providerPaymentId: paid.providerPaymentId, amountPaise: 6_000, reason: "Customer request" });
    expect((await provider.fetchPayment(paid.providerPaymentId)).status).toBe("refunded");
    await expectProviderError(() => provider.refund({ providerPaymentId: paid.providerPaymentId, amountPaise: 1, reason: "x" }), "invalid_request");
    // fetchRefund reports what the mock settled (processed), or a failure a test sets.
    expect(await provider.fetchRefund(first.providerRefundId)).toEqual({
      providerRefundId: first.providerRefundId,
      providerPaymentId: paid.providerPaymentId,
      status: "processed",
      amountPaise: 4_000,
      currency: "INR",
    });
    mockSetRefundStatus(first.providerRefundId, "failed");
    expect((await provider.fetchRefund(first.providerRefundId)).status).toBe("failed");
    await expectProviderError(() => provider.fetchRefund("rfnd_mock_missing"), "not_found");
  });

  it("refuses refunds for failed or unknown payments and without a reason", async () => {
    const failed = mockFail("order_mock_failed", 10_000);
    await expectProviderError(() => provider.refund({ providerPaymentId: failed.providerPaymentId, amountPaise: 1, reason: "x" }), "invalid_request");
    await expectProviderError(() => provider.refund({ providerPaymentId: "pay_mock_nope", amountPaise: 1, reason: "x" }), "not_found");
    const paid = mockCapture("order_mock_reason", 100);
    await expectProviderError(() => provider.refund({ providerPaymentId: paid.providerPaymentId, amountPaise: 100, reason: "  " }), "invalid_request");
  });
});

describe("configuration", () => {
  it("refuses an empty key secret", () => {
    expect(() => new MockProvider({ keyId: "k", keySecret: "", webhookSecret })).toThrow(PaymentProviderError);
  });

  it("has no Cashfree adapter yet (Razorpay: tests/unit/razorpay-api.test.ts)", async () => {
    setIntegrationEnvForTests({ NODE_ENV: "test", PAYMENT_PROVIDER: "cashfree", PAYMENT_KEY_ID: "cf_key", PAYMENT_KEY_SECRET: keySecret, PAYMENT_WEBHOOK_SECRET: webhookSecret });
    expect(await activePaymentProviderOrNull()).toBeNull();
  });

  it("refuses the mock in production, by name or as the env fallback", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getPaymentProvider("mock")).toThrow(expect.objectContaining({ code: "not_configured", provider: "mock" }));
    setIntegrationEnvForTests({ NODE_ENV: "production", PAYMENT_PROVIDER: "mock", PAYMENT_KEY_SECRET: keySecret, PAYMENT_WEBHOOK_SECRET: webhookSecret });
    expect(await activePaymentProviderOrNull()).toBeNull();
  });

  it("builds the mock from the environment", async () => {
    const pair = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const envKeySecret = randomBytes(24).toString("base64url");
    const env: Record<string, string> = {
      APP_URL: "http://localhost:3000",
      NODE_ENV: "test",
      SESSION_SECRET: randomBytes(48).toString("base64url"),
      CSRF_SECRET: randomBytes(32).toString("base64url"),
      ORDER_TOKEN_SECRET: randomBytes(32).toString("base64url"),
      CRON_SECRET: randomBytes(32).toString("base64url"),
      DATABASE_URL: "postgresql://axiomatic:axiomatic@localhost:5432/axiomatic?schema=public",
      LICENSE_KEY_PEPPER: randomBytes(32).toString("hex"),
      LICENSE_KEY_ENC_KEY: randomBytes(32).toString("base64"),
      LICENSE_SIGNING_PRIVATE_KEY: pair.privateKey,
      LICENSE_SIGNING_PUBLIC_KEY: pair.publicKey,
      PAYMENT_PROVIDER: "mock",
      PAYMENT_KEY_ID: "mock_env_key",
      PAYMENT_KEY_SECRET: envKeySecret,
      PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString("base64url"),
      EMAIL_FROM: "Axiomatic Software <no-reply@axiomatic.example>",
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    resetEnvCache();
    const fromEnv = getPaymentProvider("mock");
    expect(fromEnv.key).toBe("mock");
    expect(fromEnv.keyId).toBe("mock_env_key");
    expect(getPaymentProvider("mock")).toBe(fromEnv);
    // The active provider (resolver, env fallback) is the same mock configuration.
    const active = await activePaymentProvider();
    expect(active.key).toBe("mock");
    expect(active.keyId).toBe("mock_env_key");
    expect(active.verifyReturnSignature({ providerOrderId: "order_mock_a", providerPaymentId: "pay_mock_a", signature: signMockReturn("order_mock_a", "pay_mock_a") })).toBe(true);
    const ids = { providerOrderId: "order_mock_env", providerPaymentId: "pay_mock_env" };
    expect(fromEnv.verifyReturnSignature({ ...ids, signature: signMockReturn(ids.providerOrderId, ids.providerPaymentId) })).toBe(true);
    expect(fromEnv.verifyReturnSignature({ ...ids, signature: hex(envKeySecret, "order_mock_env|pay_mock_env") })).toBe(true);
  });
});
