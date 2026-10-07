import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { setLogSink } from "@/lib/log";
import { resetPaymentProviders } from "@/lib/payments";
import { MockProvider } from "@/lib/payments/mock";
import {
  deliverMockWebhook,
  MOCK_RETRY_DELAYS_MS,
  MOCK_WEBHOOK_PATH,
  mockCheckoutEnabled,
  mockReturnPath,
  scheduleMockWebhook,
} from "@/lib/payments/mock-delivery";

const webhookSecret = randomBytes(32).toString("base64url");

function stubEnv(over: Record<string, string> = {}): void {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const env: Record<string, string> = {
    APP_URL: "http://localhost:3999",
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
    PAYMENT_WEBHOOK_SECRET: webhookSecret,
    EMAIL_FROM: "Axiomatic Software <no-reply@axiomatic.example>",
    ...over,
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  resetEnvCache();
  resetPaymentProviders();
}

const event = {
  type: "payment.captured" as const,
  providerOrderId: "order_mock_delivery01",
  providerPaymentId: "pay_mock_delivery01",
  amountPaise: 100_000,
  method: "Card",
};

beforeEach(() => {
  stubEnv();
  setLogSink(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetEnvCache();
  resetPaymentProviders();
  setLogSink(null);
});

describe("deliverMockWebhook", () => {
  it("POSTs a body the mock provider verifies to APP_URL + the webhook path", async () => {
    const seen: Array<{ url: string; body: string; headers: Headers }> = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ result: "fulfilled" }), { status: 200 });
    }) as typeof fetch;
    expect(await deliverMockWebhook(event, { fetch: fetchStub })).toEqual({ status: 200, result: "fulfilled" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`http://localhost:3999${MOCK_WEBHOOK_PATH}`);
    const verifier = new MockProvider({ keyId: "k", keySecret: "unused-secret", webhookSecret });
    expect(verifier.verifyWebhook(seen[0]!.body, seen[0]!.headers)).toMatchObject({ ok: true, event: { ...event, currency: "INR" } });
  });

  it("schedules delivery after the delay", async () => {
    vi.useFakeTimers();
    const fetchStub = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    scheduleMockWebhook(event, 1_500, { fetch: fetchStub, appUrl: "http://127.0.0.1:3001/" });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(fetchStub).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchStub).mock.calls[0]?.[0]).toBe(`http://127.0.0.1:3001${MOCK_WEBHOOK_PATH}`);
  });

  it("sends a failed delivery again with the same event id, like a provider (no answer or 5xx), at most 3 times", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    let calls = 0;
    const fetchStub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      ids.push((JSON.parse(String(init?.body)) as { id: string }).id);
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response("{}", { status: calls === 2 ? 503 : 200 });
    }) as unknown as typeof fetch;
    scheduleMockWebhook(event, 0, { fetch: fetchStub });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MOCK_RETRY_DELAYS_MS[0]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MOCK_RETRY_DELAYS_MS[1]);
    expect(fetchStub).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(new Set(ids).size).toBe(1);
  });

  it("swallows delivery failures (fire and forget)", async () => {
    vi.useFakeTimers();
    const fetchStub = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    scheduleMockWebhook(event, 0, { fetch: fetchStub });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("dev gate and return path", () => {
  it("is enabled only outside production with the mock provider", () => {
    expect(mockCheckoutEnabled()).toBe(true);
    stubEnv({ PAYMENT_PROVIDER: "razorpay" });
    expect(mockCheckoutEnabled()).toBe(false);
    stubEnv({ NODE_ENV: "production" });
    expect(mockCheckoutEnabled()).toBe(false);
  });

  it("returns to the order page and keeps the order link token", () => {
    expect(mockReturnPath("AX-10312", null)).toBe("/orders/AX-10312");
    expect(mockReturnPath("AX-10312", "o1.abc.def+/=")).toBe("/orders/AX-10312?t=o1.abc.def%2B%2F%3D");
  });
});
