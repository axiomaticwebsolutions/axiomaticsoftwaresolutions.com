import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { setLogSink } from "@/lib/log";
import { getPaymentProvider, resetPaymentProviders } from "@/lib/payments";
import { RAZORPAY_API_BASE, RazorpayProvider } from "@/lib/payments/razorpay";
import { PaymentProviderError } from "@/lib/payments/types";

const KEY_ID = "rzp_test_1DP5mmOlF5G5ag";
const KEY_SECRET = "thisIsTheKeySecret0123";
const WEBHOOK_SECRET = "whsec_unit_api_000001";

type Call = { url: string; init: RequestInit };
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stub(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function provider(handler: Handler, extra: { timeoutMs?: number } = {}) {
  const s = stub(handler);
  return { p: new RazorpayProvider({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, fetch: s.fetch, ...extra }), calls: s.calls };
}

async function providerError(fn: () => Promise<unknown>): Promise<PaymentProviderError> {
  const error = await fn().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentProviderError);
  return error as PaymentProviderError;
}

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);
const basic = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}`;

const payment = (over: Record<string, unknown> = {}) => ({
  id: "pay_Api0000000001",
  entity: "payment",
  amount: 589_882,
  currency: "INR",
  status: "captured",
  order_id: "order_Api000000001",
  method: "upi",
  vpa: "priya@okicici",
  email: "priya@sharmamedicals.example",
  contact: "+919820000000",
  created_at: 1_767_000_000,
  ...over,
});

afterEach(() => {
  setLogSink(null);
  vi.unstubAllEnvs();
  resetEnvCache();
  resetPaymentProviders();
});

describe("createOrder", () => {
  it("POSTs /orders with Basic auth, INR amount in paise, receipt and notes, and returns the checkout payload", async () => {
    const { p, calls } = provider(() =>
      jsonResponse(200, { id: "order_Api000000001", entity: "order", amount: 589_882, amount_paid: 0, currency: "INR", receipt: "AX-10312", status: "created" }),
    );
    const result = await p.createOrder({ orderId: "AX-10312", amountPaise: 589_882, customer: { email: "priya@sharmamedicals.example", phone: "9820000000" } });
    expect(result).toEqual({
      providerOrderId: "order_Api000000001",
      checkout: { keyId: KEY_ID, providerOrderId: "order_Api000000001", amountPaise: 589_882, currency: "INR" },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${RAZORPAY_API_BASE}/orders`);
    expect(call?.init.method).toBe("POST");
    expect(header(call!.init, "authorization")).toBe(basic);
    expect(header(call!.init, "content-type")).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({ amount: 589_882, currency: "INR", receipt: "AX-10312", notes: { orderId: "AX-10312" } });
    // The customer's contact details stay in the browser (Checkout.js prefill).
    expect(String(call?.init.body)).not.toContain("priya");
  });

  it("validates input before calling Razorpay", async () => {
    const { p, calls } = provider(() => jsonResponse(500, {}));
    for (const amountPaise of [0, -1, 10.5, Number.NaN]) {
      expect((await providerError(() => p.createOrder({ orderId: "AX-1", amountPaise, customer: { email: "a@b.co" } }))).code).toBe("invalid_request");
    }
    expect((await providerError(() => p.createOrder({ orderId: "A".repeat(41), amountPaise: 100, customer: { email: "a@b.co" } }))).code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("refuses an order created with another amount or currency", async () => {
    const { p } = provider(() => jsonResponse(200, { id: "order_Api000000002", amount: 100, currency: "INR" }));
    expect((await providerError(() => p.createOrder({ orderId: "AX-2", amountPaise: 200, customer: { email: "a@b.co" } }))).code).toBe("provider_error");
  });
});

describe("payments and refunds", () => {
  it("fetchPayment GETs /payments/:id and normalizes it", async () => {
    const { p, calls } = provider(() => jsonResponse(200, payment()));
    expect(await p.fetchPayment("pay_Api0000000001")).toEqual({
      providerPaymentId: "pay_Api0000000001",
      providerOrderId: "order_Api000000001",
      status: "captured",
      amountPaise: 589_882,
      currency: "INR",
      method: "UPI",
    });
    expect(calls[0]?.url).toBe(`${RAZORPAY_API_BASE}/payments/pay_Api0000000001`);
    expect(calls[0]?.init.method).toBe("GET");
    expect(header(calls[0]!.init, "authorization")).toBe(basic);
  });

  it("fetchOrderPayments GETs /orders/:id/payments and drops instrument details", async () => {
    const items = [
      payment({ id: "pay_Api0000000002", status: "failed", error_description: "Payment declined by the bank.", order_id: undefined }),
      payment(),
    ];
    const { p, calls } = provider(() => jsonResponse(200, { entity: "collection", count: 2, items }));
    const list = await p.fetchOrderPayments("order_Api000000001");
    expect(calls[0]?.url).toBe(`${RAZORPAY_API_BASE}/orders/order_Api000000001/payments`);
    expect(list.map((x) => [x.providerPaymentId, x.providerOrderId, x.status, x.failureReason])).toEqual([
      ["pay_Api0000000002", "order_Api000000001", "failed", "Payment declined by the bank."],
      ["pay_Api0000000001", "order_Api000000001", "captured", undefined],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/okicici|priya|9820000000/);
  });

  it("refund POSTs /payments/:id/refund with the amount and reason", async () => {
    const { p, calls } = provider(() =>
      jsonResponse(200, { id: "rfnd_Api000000001", entity: "refund", amount: 1_000, currency: "INR", payment_id: "pay_Api0000000001", status: "processed" }),
    );
    expect(await p.refund({ providerPaymentId: "pay_Api0000000001", amountPaise: 1_000, reason: "  Duplicate\n purchase " })).toEqual({
      providerRefundId: "rfnd_Api000000001",
    });
    expect(calls[0]?.url).toBe(`${RAZORPAY_API_BASE}/payments/pay_Api0000000001/refund`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ amount: 1_000, notes: { reason: "Duplicate purchase" } });
  });

  it("fetchRefund GETs /refunds/:id and reports pending, processed or failed", async () => {
    const { p, calls } = provider(() =>
      jsonResponse(200, { id: "rfnd_Api000000001", entity: "refund", amount: 1_000, currency: "INR", payment_id: "pay_Api0000000001", status: "failed" }),
    );
    expect(await p.fetchRefund("rfnd_Api000000001")).toEqual({
      providerRefundId: "rfnd_Api000000001",
      providerPaymentId: "pay_Api0000000001",
      status: "failed",
      amountPaise: 1_000,
      currency: "INR",
    });
    expect(calls[0]?.url).toBe(`${RAZORPAY_API_BASE}/refunds/rfnd_Api000000001`);
    expect(calls[0]?.init.method).toBe("GET");
    expect((await providerError(() => p.fetchRefund("../payments"))).code).toBe("invalid_request");
  });

  it("refuses unsafe ids, bad amounts and empty reasons without calling Razorpay", async () => {
    const { p, calls } = provider(() => jsonResponse(200, {}));
    for (const id of ["../orders", "pay_1/refund", "pay 1", ""]) {
      expect((await providerError(() => p.fetchPayment(id))).code).toBe("invalid_request");
      expect((await providerError(() => p.fetchOrderPayments(id))).code).toBe("invalid_request");
    }
    expect((await providerError(() => p.refund({ providerPaymentId: "pay_1", amountPaise: 0, reason: "x" }))).code).toBe("invalid_request");
    expect((await providerError(() => p.refund({ providerPaymentId: "pay_1", amountPaise: 10, reason: "   " }))).code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });
});

describe("errors", () => {
  const cases: Array<[number, unknown, PaymentProviderError["code"]]> = [
    [401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }, "not_configured"],
    [400, { error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } }, "not_found"],
    [400, { error: { code: "BAD_REQUEST_ERROR", description: "The amount must be atleast INR 1.00" } }, "invalid_request"],
    [404, null, "not_found"],
    [429, { error: { code: "TOO_MANY_REQUESTS" } }, "provider_error"],
    [502, "Bad gateway", "provider_error"],
  ];

  it.each(cases)("maps HTTP %i to %s", async (status, body, code) => {
    const { p } = provider(() => (typeof body === "string" ? new Response(body, { status }) : jsonResponse(status, body)));
    const error = await providerError(() => p.fetchPayment("pay_Api0000000001"));
    expect(error.code).toBe(code);
    expect(error.provider).toBe("razorpay");
    expect(error.message).not.toContain(KEY_SECRET);
  });

  it("maps network failures, timeouts and unexpected bodies to provider_error and logs no secrets", async () => {
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    const down = provider(() => {
      throw new TypeError("fetch failed");
    });
    expect((await providerError(() => down.p.fetchPayment("pay_Api0000000001"))).code).toBe("provider_error");

    const slow = provider(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { timeoutMs: 20 },
    );
    const timeout = await providerError(() => slow.p.fetchPayment("pay_Api0000000001"));
    expect(timeout.code).toBe("provider_error");
    expect(timeout.message).toMatch(/did not answer/);

    const odd = provider(() => jsonResponse(200, { unexpected: true }));
    expect((await providerError(() => odd.p.fetchPayment("pay_Api0000000001"))).code).toBe("provider_error");

    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(text).not.toContain(KEY_SECRET);
    expect(text).not.toContain(Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64"));
  });
});

describe("configuration", () => {
  it("refuses missing secrets", () => {
    expect(() => new RazorpayProvider({ keyId: KEY_ID, keySecret: "", webhookSecret: WEBHOOK_SECRET })).toThrow(
      expect.objectContaining({ code: "not_configured", provider: "razorpay" }),
    );
  });

  it("getPaymentProvider('razorpay') builds the adapter from the environment", () => {
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
      PAYMENT_PROVIDER: "razorpay",
      PAYMENT_KEY_ID: KEY_ID,
      PAYMENT_KEY_SECRET: KEY_SECRET,
      PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString("base64url"),
      EMAIL_FROM: "Axiomatic Software <no-reply@axiomatic.example>",
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    resetEnvCache();
    const fromEnv = getPaymentProvider();
    expect(fromEnv).toBeInstanceOf(RazorpayProvider);
    expect(fromEnv.key).toBe("razorpay");
    expect((fromEnv as RazorpayProvider).keyId).toBe(KEY_ID);
    expect(getPaymentProvider("razorpay")).toBe(fromEnv);
  });
});
