/**
 * Route handlers end to end (CSRF, body parsing, status codes, headers) against the test database. The session
 * lookup (next/headers cookies) is replaced by a settable viewer; everything else is real.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session, User } from "@/generated/prisma/client";
import { csrfBinding, issueCsrfToken } from "@/lib/auth/csrf";
import { clear, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { signMockReturn } from "@/lib/payments/mock";
import { authOf, makeCustomer, markPaid, seedCatalog, uniq, type CatalogFixture, type CustomerFixture } from "./checkout-fixtures";

const state = vi.hoisted(() => ({ auth: null as { user: User; session: Session } | null, started: [] as string[] }));
vi.mock("@/lib/auth/guards", () => ({ getCurrentAuth: async () => state.auth }));
vi.mock("@/lib/auth/flows/route-helpers", () => ({
  startSessionCookies: async (_token: string, session: { id: string }) => {
    state.started.push(session.id);
  },
}));

const { POST: quoteRoute } = await import("@/app/api/checkout/quote/route");
const { POST: ordersRoute } = await import("@/app/api/checkout/orders/route");
const { POST: returnRoute } = await import("@/app/api/checkout/orders/[id]/return/route");
const { POST: cancelRoute } = await import("@/app/api/checkout/orders/[id]/cancel/route");
const { POST: retryRoute } = await import("@/app/api/checkout/orders/[id]/retry/route");
const { GET: statusRoute } = await import("@/app/api/orders/[id]/status/route");

let cat: CatalogFixture;
let owner: CustomerFixture;
const BASE = "http://localhost:3000";

beforeAll(async () => {
  cat = await seedCatalog();
  owner = await makeCustomer({ role: "OWNER" });
});

afterAll(async () => {
  await clear(db, RATE_LIMITS.couponIp(null).key);
});

function headers(opts: { csrf?: boolean; origin?: string; json?: boolean } = {}): Record<string, string> {
  const h: Record<string, string> = { origin: opts.origin ?? getEnv().APP_URL };
  if (opts.json !== false) h["content-type"] = "application/json";
  if (opts.csrf !== false) {
    const token = issueCsrfToken(csrfBinding(state.auth?.session.id), getEnv().CSRF_SECRET);
    h["x-csrf-token"] = token;
    h.cookie = `axs_csrf=${token}`;
  }
  return h;
}

function post(path: string, body?: unknown, opts: Parameters<typeof headers>[0] = {}): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: "POST",
    headers: headers({ ...opts, json: body !== undefined && opts.json !== false }),
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const billing = (email: string) => ({
  name: "Priya Sharma",
  email,
  phone: "9820000000",
  address: "12 MG Road",
  city: "Pune",
  state: "Maharashtra",
  pin: "411001",
});

type Created = { orderId: string; orderToken: string; statusUrl: string; checkout: { kind: string; url: string } };

async function createGuestOrder(): Promise<Created> {
  state.auth = null;
  const res = await ordersRoute(
    post("/api/checkout/orders", { items: [{ planId: cat.plans.annual.id, qty: 1 }], billing: billing(`${uniq("rt")}@example.test`), acceptTerms: true }),
    undefined,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

describe("POST /api/checkout/quote", () => {
  it("prices a guest cart", async () => {
    state.auth = null;
    const res = await quoteRoute(post("/api/checkout/quote", { items: [{ planId: cat.plans.annual.id, qty: 1 }], billingState: "Karnataka" }), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { totalPaise: number; igstPaise: number; lines: unknown[] };
    expect(body.lines).toHaveLength(1);
    expect(body.igstPaise).toBe(Math.round(499_900 * 0.18));
  });

  it("refuses missing CSRF tokens, other origins, non-JSON and unknown keys", async () => {
    state.auth = null;
    const items = { items: [{ planId: cat.plans.annual.id, qty: 1 }] };
    const noToken = await quoteRoute(post("/api/checkout/quote", items, { csrf: false }), undefined);
    expect([noToken.status, ((await noToken.json()) as { error: { code: string } }).error.code]).toEqual([403, "csrf_failed"]);
    expect((await quoteRoute(post("/api/checkout/quote", items, { origin: "https://evil.example" }), undefined)).status).toBe(403);
    const text = new NextRequest(`${BASE}/api/checkout/quote`, { method: "POST", headers: { ...headers(), "content-type": "text/plain" }, body: "x" });
    expect((await quoteRoute(text, undefined)).status).toBe(415);
    const extra = await quoteRoute(post("/api/checkout/quote", { items: [{ planId: cat.plans.annual.id, qty: 1, unitPricePaise: 1 }] }), undefined);
    expect(extra.status).toBe(422);
    expect(await extra.json()).toMatchObject({ error: { code: "validation_failed", fieldErrors: { "items.0.unitPricePaise": ["Unknown field."] } } });
  });

  it("rate-limits coupon checks per IP with Retry-After", async () => {
    state.auth = null;
    const rule = RATE_LIMITS.couponIp(null);
    await clear(db, rule.key);
    for (let i = 0; i < rule.limit; i += 1) await hit(db, rule);
    const res = await quoteRoute(post("/api/checkout/quote", { items: [], couponCode: "WELCOME10" }), undefined);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: { code: "too_many_attempts" } });
    await clear(db, rule.key);
  });
});

describe("POST /api/checkout/orders", () => {
  it("answers 201 with the checkout payload only", async () => {
    const created = await createGuestOrder();
    expect(Object.keys(created).sort()).toEqual(["checkout", "orderId", "orderToken", "statusUrl"]);
    expect(created.checkout.kind).toBe("mock");
    expect(created.statusUrl).toBe(`/orders/${created.orderId}?t=${created.orderToken}`);
  });

  it("signs in the customer created at checkout", async () => {
    state.auth = null;
    state.started = [];
    const email = `${uniq("rtnew")}@example.test`;
    const res = await ordersRoute(
      post("/api/checkout/orders", {
        items: [{ planId: cat.plans.annual.id, qty: 1 }],
        billing: billing(email),
        acceptTerms: true,
        createAccount: { password: "s3cure-pass" },
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("session");
    expect(body).not.toHaveProperty("createdUserId");
    expect(state.started).toHaveLength(1);
    const session = await db.session.findUniqueOrThrow({ where: { id: state.started[0] ?? "" }, include: { user: true } });
    expect(session.user.email).toBe(email);
  });

  it("validates the body (422) and the cart", async () => {
    state.auth = null;
    const empty = await ordersRoute(post("/api/checkout/orders", { items: [], billing: billing("a@example.test"), acceptTerms: true }), undefined);
    expect(empty.status).toBe(422);
    expect(await empty.json()).toMatchObject({ error: { fieldErrors: { items: ["Your cart is empty."] } } });
    const trial = await ordersRoute(
      post("/api/checkout/orders", { items: [{ planId: cat.plans.trial.id, qty: 1 }], billing: billing("a@example.test"), acceptTerms: true }),
      undefined,
    );
    expect(trial.status).toBe(422);
    expect(await trial.json()).toMatchObject({ error: { code: "cart_invalid", issues: [{ code: "trial_not_purchasable" }] } });
  });
});

describe("order routes", () => {
  const status = (id: string, t?: string) =>
    statusRoute(new NextRequest(`${BASE}/api/orders/${id}/status${t ? `?t=${t}` : ""}`, { headers: { referer: `${BASE}/orders/${id}` } }), idCtx(id));

  it("serves the status to the link holder only, never cached", async () => {
    const created = await createGuestOrder();
    state.auth = null;
    const ok = await status(created.orderId, created.orderToken);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await ok.json()).toMatchObject({ id: created.orderId, status: "AWAITING_PAYMENT", canRetry: true });
    expect((await status(created.orderId)).status).toBe(401);
    state.auth = authOf(owner);
    expect((await status(created.orderId)).status).toBe(404);
    state.auth = null;
  });

  it("takes the link token from the X-Order-Token header the order page polls with (no token in the URL)", async () => {
    const created = await createGuestOrder();
    await markPaid(created.orderId);
    state.auth = null;
    const viaHeader = (token: string) =>
      statusRoute(
        new NextRequest(`${BASE}/api/orders/${created.orderId}/status`, {
          headers: { referer: `${BASE}/orders/${created.orderId}`, "x-order-token": token },
        }),
        idCtx(created.orderId),
      );
    const ok = await viaHeader(created.orderToken);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { licenses: Array<{ key?: string }> }).licenses[0]?.key).toBeTruthy();
    expect((await viaHeader("o1.not-a-token")).status).toBe(404);
  });

  it("delivers the key once through the status route", async () => {
    const created = await createGuestOrder();
    await markPaid(created.orderId);
    const first = (await (await status(created.orderId, created.orderToken)).json()) as { licenses: Array<{ key?: string }> };
    const second = (await (await status(created.orderId, created.orderToken)).json()) as { licenses: Array<{ key?: string }> };
    expect(first.licenses[0]?.key).toBeTruthy();
    expect(second.licenses[0]?.key).toBeUndefined();
  });

  it("never delivers keys to cross-site requests", async () => {
    const created = await createGuestOrder();
    await markPaid(created.orderId);
    const crossSite = new NextRequest(`${BASE}/api/orders/${created.orderId}/status?t=${created.orderToken}`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    const body = (await (await statusRoute(crossSite, idCtx(created.orderId))).json()) as { licenses: Array<{ key?: string }> };
    expect(body.licenses[0]?.key).toBeUndefined();
    const again = (await (await status(created.orderId, created.orderToken)).json()) as { licenses: Array<{ key?: string }> };
    expect(again.licenses[0]?.key).toBeTruthy();
  });

  it("records a signed payment return as CONFIRMING and rejects forged ones", async () => {
    const created = await createGuestOrder();
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: created.orderId } });
    const forged = await returnRoute(
      post(`/api/checkout/orders/${created.orderId}/return`, { providerPaymentId: "pay_rt", providerSignature: "00ff", t: created.orderToken }),
      idCtx(created.orderId),
    );
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ error: { code: "invalid_signature" } });
    const res = await returnRoute(
      post(`/api/checkout/orders/${created.orderId}/return?t=${created.orderToken}`, {
        providerPaymentId: "pay_rt",
        providerSignature: signMockReturn(payment.providerOrderId, "pay_rt"),
      }),
      idCtx(created.orderId),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "CONFIRMING" });
    expect(await db.license.count({ where: { orderId: created.orderId } })).toBe(0);
  });

  it("cancels without a body and retries with 201", async () => {
    const created = await createGuestOrder();
    const cancel = await cancelRoute(post(`/api/checkout/orders/${created.orderId}/cancel?t=${created.orderToken}`), idCtx(created.orderId));
    expect([cancel.status, await cancel.json()]).toEqual([200, { status: "CANCELED" }]);
    const retry = await retryRoute(post(`/api/checkout/orders/${created.orderId}/retry`, { t: created.orderToken }), idCtx(created.orderId));
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ orderId: created.orderId, checkout: { kind: "mock" } });
    const stranger = await makeCustomer({ role: "OWNER" });
    state.auth = authOf(stranger);
    const denied = await cancelRoute(post(`/api/checkout/orders/${created.orderId}/cancel`, {}), idCtx(created.orderId));
    expect(denied.status).toBe(404);
    state.auth = null;
    expect((await cancelRoute(post(`/api/checkout/orders/${created.orderId}/cancel`, {}), idCtx(created.orderId))).status).toBe(401);
  });
});
