import { generateKeyPairSync, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RateLimitModule from "@/lib/auth/rate-limit";
import { resetEnvCache } from "@/lib/env";
import { setIntegrationEnvForTests } from "@/lib/integrations/resolver";
import { resetPaymentProviders } from "@/lib/payments";
import { buildMockWebhook, signMockWebhook } from "@/lib/payments/mock";

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  record: vi.fn(),
  hit: vi.fn(),
}));

vi.mock("@/lib/payments/webhook", () => ({
  processPaymentEvent: mocks.process,
  recordWebhookDelivery: mocks.record,
}));
// Only hit() is faked; the rules (RATE_LIMITS.webhookInvalidIp) are the real ones.
vi.mock("@/lib/auth/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  hit: mocks.hit,
}));

const { POST } = await import("@/app/api/webhooks/payments/[provider]/route");

function stubEnv(): void {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
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
    PAYMENT_KEY_ID: "mock_unit_key",
    PAYMENT_KEY_SECRET: randomBytes(24).toString("base64url"),
    PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString("base64url"),
    EMAIL_FROM: "Axiomatic Software <no-reply@axiomatic.example>",
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  resetEnvCache();
  resetPaymentProviders();
}

beforeAll(stubEnv);
afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetPaymentProviders();
});
beforeEach(() => {
  mocks.process.mockReset().mockResolvedValue({ status: 200, result: "fulfilled" });
  mocks.record.mockReset().mockResolvedValue(undefined);
  mocks.hit.mockReset().mockResolvedValue({ allowed: true });
});

const event = {
  type: "payment.captured" as const,
  providerOrderId: "order_mock_unit000001",
  providerPaymentId: "pay_mock_unit000001",
  amountPaise: 589_882,
  method: "UPI",
};

async function post(provider: string, body: BodyInit | null, headers: HeadersInit) {
  const req = new NextRequest(`http://localhost:3000/api/webhooks/payments/${provider}`, { method: "POST", headers, body });
  const res = await POST(req, { params: Promise.resolve({ provider }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

describe("POST /api/webhooks/payments/:provider", () => {
  it("hands a verified event to processPaymentEvent and answers its result, uncached", async () => {
    const { rawBody, headers, event: full } = buildMockWebhook(event);
    mocks.process.mockResolvedValueOnce({ status: 200, result: "already_paid" });
    const res = await post("mock", rawBody, headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: "already_paid" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.process).toHaveBeenCalledWith("mock", full);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("503 payments_not_configured for razorpay while payments are not configured (Razorpay retries), 404 for the rest", async () => {
    setIntegrationEnvForTests({ NODE_ENV: "production" });
    try {
      const body = JSON.stringify({ entity: "event", event: "payment.captured", payload: {} });
      const headers = { "content-type": "application/json", "x-razorpay-signature": "0".repeat(64) };
      const res = await post("razorpay", body, headers);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: { code: "payments_not_configured", message: "Payments are not configured." } });
      expect(res.headers.get("retry-after")).toBe("300");
      expect(res.headers.get("cache-control")).toBe("no-store");
      for (const provider of ["mock", "cashfree", "paypal"]) expect((await post(provider, body, headers)).status, provider).toBe(404);
      expect(mocks.process).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.hit).not.toHaveBeenCalled();
    } finally {
      setIntegrationEnvForTests(null);
    }
  });

  it("404 for unknown providers and for providers other than the configured one", async () => {
    const { rawBody, headers } = buildMockWebhook(event);
    for (const provider of ["paypal", "razorpay", "cashfree", "MOCK"]) {
      expect((await post(provider, rawBody, headers)).status).toBe(404);
    }
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("401 invalid_signature for missing or bad signatures, recorded as a delivery", async () => {
    const { rawBody } = buildMockWebhook(event);
    const variants: Array<Record<string, string>> = [{}, { "x-mock-signature": "f".repeat(64) }, { "x-mock-signature": signMockWebhook(`${rawBody} `) }];
    for (const headers of variants) {
      const res = await post("mock", rawBody, headers);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: "invalid_signature", message: "The webhook signature is not valid." } });
    }
    expect(mocks.record).toHaveBeenCalledTimes(3);
    expect(mocks.record).toHaveBeenCalledWith({ provider: "mock", signatureOk: false, result: "invalid_signature" });
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("stops recording rejected signatures past the per-IP limit (still 401), and records when the limiter is down", async () => {
    const { rawBody } = buildMockWebhook(event);
    mocks.hit.mockResolvedValueOnce({ allowed: false });
    expect((await post("mock", rawBody, { "x-mock-signature": "0" })).status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled();
    mocks.hit.mockRejectedValueOnce(new Error("db down"));
    expect((await post("mock", rawBody, { "x-mock-signature": "0" })).status).toBe(401);
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it("signed but ignored or unreadable bodies answer 200 so the provider stops retrying", async () => {
    const ignored = JSON.stringify({ ...event, id: "evt_mock_ignored", type: "payment.authorized", currency: "INR" });
    expect((await post("mock", ignored, { "x-mock-signature": signMockWebhook(ignored) })).body).toEqual({ result: "ignored" });
    const junk = "[1,2";
    expect((await post("mock", junk, { "x-mock-signature": signMockWebhook(junk) })).body).toEqual({ result: "invalid_payload" });
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([
      { provider: "mock", signatureOk: true, result: "ignored" },
      { provider: "mock", signatureOk: true, result: "invalid_payload" },
    ]);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("refuses oversized and non-UTF-8 bodies before processing", async () => {
    const big = "x".repeat(256 * 1024 + 1);
    const res = await post("mock", big, { "x-mock-signature": signMockWebhook(big) });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: { code: "payload_too_large" } });
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    expect((await post("mock", bytes, { "x-mock-signature": "0" })).status).toBe(401);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("answers 500 when processing fails, so the provider retries", async () => {
    const { rawBody, headers } = buildMockWebhook(event);
    mocks.process.mockRejectedValueOnce(new Error("connection refused"));
    const res = await post("mock", rawBody, headers);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: { code: "internal_error" } });
  });
});
