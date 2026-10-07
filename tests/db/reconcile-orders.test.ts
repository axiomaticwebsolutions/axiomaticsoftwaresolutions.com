import { randomBytes, randomInt } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { OrderStatus, PaymentStatus, Plan } from "@/generated/prisma/client";
import { GET } from "@/app/api/cron/reconcile/route";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getPaymentProvider } from "@/lib/payments";
import { closedAttemptDue, reconcileEvents, reconcileStuckOrders, RECONCILE_INTERVAL_MS, RECONCILE_MIN_AGE_MS } from "@/lib/payments/reconcile";
import type { NormalizedPayment, PaymentProvider } from "@/lib/payments/types";
import { processPaymentEvent } from "@/lib/payments/webhook";
import { NextRequest } from "next/server";

const tag = randomBytes(3).toString("hex");
let plan: Plan;

beforeAll(async () => {
  const category = await db.category.create({ data: { id: `rcat-${tag}`, name: "Test", tone: "blue", icon: "receipt_long" } });
  let code = "";
  for (;;) {
    code = Array.from({ length: 3 }, () => String.fromCharCode(65 + randomInt(26))).join("");
    if (!(await db.product.findUnique({ where: { code } }))) break;
  }
  const product = await db.product.create({
    data: {
      id: `rc-${tag}`,
      code,
      name: `Reconcile ${tag}`,
      shortName: "Reconcile",
      tagline: "Test",
      summary: "Test",
      icon: "receipt_long",
      categoryId: category.id,
      platforms: ["windows"],
      status: "PUBLISHED",
      content: {},
      relatedIds: [],
    },
  });
  plan = await db.plan.create({
    data: { id: `rc-annual-${tag}`, productId: product.id, type: "ANNUAL", name: "Annual license", interval: "YEAR", pricePaise: 299_900, includes: [], deviceLimit: 1 },
  });
});

/** Provider stand-in: the payments the "provider" reports per provider order id. Unknown ids have none. */
const ledger = new Map<string, NormalizedPayment[]>();
const failing = new Set<string>();
const real = () => getPaymentProvider("mock");
const provider: PaymentProvider = {
  key: "mock",
  createOrder: (i) => real().createOrder(i),
  verifyReturnSignature: (i) => real().verifyReturnSignature(i),
  verifyWebhook: (b, h) => real().verifyWebhook(b, h),
  fetchPayment: (id) => real().fetchPayment(id),
  refund: (i) => real().refund(i),
  fetchRefund: (id) => real().fetchRefund(id),
  async fetchOrderPayments(providerOrderId) {
    if (failing.has(providerOrderId)) throw new Error("provider down");
    return ledger.get(providerOrderId) ?? [];
  },
};

let seq = 0;
type Stuck = { id: string; total: number; providerOrderId: string };

async function stuckOrder(status: OrderStatus, ageMs: number, paymentStatus: PaymentStatus = "CREATED"): Promise<Stuck> {
  seq += 1;
  const id = `AX-${randomInt(10_000_000, 99_999_999)}`;
  const total = Math.round(plan.pricePaise * 1.18);
  const providerOrderId = `order_mock_rc${tag}${seq}`;
  const at = new Date(Date.now() - ageMs);
  await db.order.create({
    data: {
      id,
      email: `rc-${tag}-${seq}@example.test`,
      billing: { name: "Kavya Desai", state: "Karnataka" },
      status,
      subtotalPaise: plan.pricePaise,
      taxablePaise: plan.pricePaise,
      igstPaise: total - plan.pricePaise,
      totalPaise: total,
      placeOfSupply: "Karnataka",
      createdAt: at,
      items: { create: [{ planId: plan.id, unitPricePaise: plan.pricePaise, taxablePaise: plan.pricePaise, taxPaise: total - plan.pricePaise }] },
      payments: { create: [{ provider: "mock", providerOrderId, amountPaise: total, status: paymentStatus, createdAt: at }] },
    },
  });
  return { id, total, providerOrderId };
}

const capturedPayment = (o: Stuck, n = 1): NormalizedPayment => ({
  providerPaymentId: `pay_mock_rc${tag}${seq}n${n}`,
  providerOrderId: o.providerOrderId,
  status: "captured",
  amountPaise: o.total,
  currency: "INR",
  method: "UPI",
});
const failedPayment = (o: Stuck, n = 1): NormalizedPayment => ({ ...capturedPayment(o, n), status: "failed", failureReason: "Bank declined." });
const statusOf = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).status;
const licenseCount = (id: string) => db.license.count({ where: { orderId: id } });
const MIN = 60_000;

describe("reconcileEvents", () => {
  const o: Stuck = { id: "AX-1", total: 100, providerOrderId: "order_mock_x" };
  it("prefers captured payments, fails only when every attempt failed, and waits otherwise", () => {
    expect(reconcileEvents(o.providerOrderId, [failedPayment(o, 1), capturedPayment(o, 2)])).toMatchObject([
      { id: `reconcile:${capturedPayment(o, 2).providerPaymentId}`, type: "payment.captured", amountPaise: 100, method: "UPI" },
    ]);
    expect(reconcileEvents(o.providerOrderId, [failedPayment(o, 1)])).toMatchObject([{ type: "payment.failed", failureReason: "Bank declined." }]);
    expect(reconcileEvents(o.providerOrderId, [failedPayment(o, 1), { ...capturedPayment(o, 2), status: "authorized" }])).toEqual([]);
    expect(reconcileEvents(o.providerOrderId, [{ ...capturedPayment(o, 2), status: "refunded" }])).toEqual([]);
    expect(reconcileEvents(o.providerOrderId, [])).toEqual([]);
  });
});

describe("reconcileStuckOrders", () => {
  it("fulfils an order whose webhook never arrived, idempotently", async () => {
    const order = await stuckOrder("CONFIRMING", 20 * MIN, "AUTHORIZED");
    const payment = capturedPayment(order);
    ledger.set(order.providerOrderId, [payment]);

    const first = await reconcileStuckOrders({ provider, limit: 500 });
    expect(first.results.fulfilled).toBeGreaterThanOrEqual(1);
    expect(await statusOf(order.id)).toBe("PAID");
    expect(await licenseCount(order.id)).toBe(1);
    expect(await db.invoice.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { provider_id: { provider: "mock", id: `reconcile:${payment.providerPaymentId}` } } })).toMatchObject({
      result: "fulfilled",
      orderId: order.id,
    });

    // Run twice: the order is no longer stuck, nothing is applied again.
    await reconcileStuckOrders({ provider, limit: 500 });
    expect(await licenseCount(order.id)).toBe(1);
    expect(await db.webhookDelivery.count({ where: { eventId: `reconcile:${payment.providerPaymentId}` } })).toBe(1);

    // The real webhook arriving late is answered already_paid.
    const late = await processPaymentEvent("mock", {
      id: `evt_late_${tag}`,
      type: "payment.captured",
      providerOrderId: order.providerOrderId,
      providerPaymentId: payment.providerPaymentId,
      amountPaise: order.total,
      currency: "INR",
    });
    expect(late.result).toBe("already_paid");
    expect(await licenseCount(order.id)).toBe(1);
  });

  it("is idempotent when the same stuck order is reconciled twice concurrently", async () => {
    const order = await stuckOrder("PENDING", 30 * MIN, "PENDING");
    ledger.set(order.providerOrderId, [capturedPayment(order)]);
    await Promise.all([reconcileStuckOrders({ provider, limit: 500 }), reconcileStuckOrders({ provider, limit: 500 })]);
    expect(await statusOf(order.id)).toBe("PAID");
    expect(await licenseCount(order.id)).toBe(1);
    expect(await db.invoice.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("leaves fresh orders, in-flight payments and other states alone", async () => {
    const fresh = await stuckOrder("CONFIRMING", 5 * MIN, "AUTHORIZED");
    ledger.set(fresh.providerOrderId, [capturedPayment(fresh)]);
    const inFlight = await stuckOrder("CONFIRMING", 20 * MIN, "AUTHORIZED");
    ledger.set(inFlight.providerOrderId, [{ ...capturedPayment(inFlight), status: "authorized" }]);
    const ancient = await stuckOrder("AWAITING_PAYMENT", 4 * 24 * 60 * MIN);
    ledger.set(ancient.providerOrderId, [capturedPayment(ancient)]);
    const oldCanceled = await stuckOrder("CANCELED", 4 * 24 * 60 * MIN, "CANCELED");
    ledger.set(oldCanceled.providerOrderId, [capturedPayment(oldCanceled)]);

    await reconcileStuckOrders({ provider, limit: 500 });
    expect(await statusOf(fresh.id)).toBe("CONFIRMING");
    expect(await statusOf(inFlight.id)).toBe("CONFIRMING");
    expect(await statusOf(ancient.id)).toBe("AWAITING_PAYMENT");
    expect(await statusOf(oldCanceled.id)).toBe("CANCELED");
    expect(await licenseCount(fresh.id)).toBe(0);
  });

  it("pays a CANCELED order whose payment completed after the checkout was closed (webhook lost)", async () => {
    const canceled = await stuckOrder("CANCELED", 20 * MIN, "CANCELED");
    ledger.set(canceled.providerOrderId, [capturedPayment(canceled)]);
    await reconcileStuckOrders({ provider, limit: 500 });
    expect(await statusOf(canceled.id)).toBe("PAID");
    expect(await licenseCount(canceled.id)).toBe(1);
  });

  it("pays a FAILED order whose provider order captured a later payment (fail, then succeed in one checkout)", async () => {
    const failedFirst = await stuckOrder("FAILED", 25 * MIN, "FAILED");
    ledger.set(failedFirst.providerOrderId, [failedPayment(failedFirst, 1), capturedPayment(failedFirst, 2)]);
    // The verified return already moved this one to CONFIRMING with the attempt AUTHORIZED; its capture webhook was lost.
    const authorized = await stuckOrder("FAILED", 30 * MIN, "AUTHORIZED");
    ledger.set(authorized.providerOrderId, [capturedPayment(authorized, 1)]);
    await reconcileStuckOrders({ provider, limit: 500 });
    for (const order of [failedFirst, authorized]) {
      expect(await statusOf(order.id)).toBe("PAID");
      expect(await licenseCount(order.id)).toBe(1);
    }
  });

  it("pays a retried order whose earlier, canceled attempt captured late", async () => {
    const order = await stuckOrder("CANCELED", 40 * MIN, "CANCELED");
    await db.order.update({ where: { id: order.id }, data: { status: "AWAITING_PAYMENT" } });
    await db.payment.create({
      data: { orderId: order.id, provider: "mock", providerOrderId: `${order.providerOrderId}r`, amountPaise: order.total, createdAt: new Date(Date.now() - 2 * MIN) },
    });
    ledger.set(order.providerOrderId, [capturedPayment(order)]);
    await reconcileStuckOrders({ provider, limit: 500 });
    expect(await statusOf(order.id)).toBe("PAID");
  });

  it("never applies failures to a closed order again (no second failure email)", async () => {
    const declined = await stuckOrder("FAILED", 20 * MIN, "FAILED");
    ledger.set(declined.providerOrderId, [failedPayment(declined, 1)]);
    const summary = await reconcileStuckOrders({ provider, limit: 500 });
    expect(summary.errors).toBe(0);
    expect(await db.webhookEvent.count({ where: { id: `reconcile:${failedPayment(declined, 1).providerPaymentId}` } })).toBe(0);
    expect(await db.outboxEmail.count({ where: { dedupeKey: { startsWith: `payment_failed:${declined.id}:` } } })).toBe(0);
    expect(await statusOf(declined.id)).toBe("FAILED");
  });

  it("checks closed attempts on a thinning schedule", () => {
    const H = 60 * MIN;
    expect(closedAttemptDue(10 * MIN)).toBe(false);
    for (const age of [15 * MIN, 50 * MIN, 119 * MIN]) expect(closedAttemptDue(age)).toBe(true);
    expect(closedAttemptDue(3 * H + 5 * MIN)).toBe(true);
    expect(closedAttemptDue(3 * H + 15 * MIN)).toBe(false);
    expect(closedAttemptDue(30 * H + 5 * MIN)).toBe(true);
    expect(closedAttemptDue(31 * H + 5 * MIN)).toBe(false);
    expect(closedAttemptDue(73 * H)).toBe(false);
    // Every 10-minute run between 15 minutes and 72 hours: about 40 checks in all.
    let checks = 0;
    for (let age = 15 * MIN; age <= 72 * H; age += RECONCILE_INTERVAL_MS) if (closedAttemptDue(age)) checks += 1;
    expect(checks).toBeGreaterThan(30);
    expect(checks).toBeLessThan(50);
  });

  it("fails an abandoned order whose only attempts failed, and pays an AWAITING_PAYMENT order that was paid", async () => {
    const declined = await stuckOrder("AWAITING_PAYMENT", 40 * MIN);
    ledger.set(declined.providerOrderId, [failedPayment(declined, 1), failedPayment(declined, 2)]);
    const paid = await stuckOrder("AWAITING_PAYMENT", 25 * MIN);
    ledger.set(paid.providerOrderId, [failedPayment(paid, 1), capturedPayment(paid, 2)]);

    await reconcileStuckOrders({ provider, limit: 500 });
    expect(await statusOf(declined.id)).toBe("FAILED");
    expect((await db.order.findUniqueOrThrow({ where: { id: declined.id } })).failReason).toBe("Bank declined.");
    expect(await db.outboxEmail.count({ where: { dedupeKey: { startsWith: `payment_failed:${declined.id}:` } } })).toBe(1);
    expect(await statusOf(paid.id)).toBe("PAID");
    expect(await licenseCount(paid.id)).toBe(1);
  });

  it("counts provider errors and carries on with the next order", async () => {
    const broken = await stuckOrder("CONFIRMING", 20 * MIN, "AUTHORIZED");
    failing.add(broken.providerOrderId);
    const ok = await stuckOrder("CONFIRMING", 21 * MIN, "AUTHORIZED");
    ledger.set(ok.providerOrderId, [capturedPayment(ok)]);
    const summary = await reconcileStuckOrders({ provider, limit: 500 });
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(await statusOf(broken.id)).toBe("CONFIRMING");
    expect(await statusOf(ok.id)).toBe("PAID");
    failing.delete(broken.providerOrderId);
  });

  it("respects the per-run limit", async () => {
    const a = await stuckOrder("CONFIRMING", 16 * MIN, "AUTHORIZED");
    const summary = await reconcileStuckOrders({ provider, limit: 1 });
    expect(summary.checked).toBe(1);
    expect(RECONCILE_MIN_AGE_MS).toBe(15 * MIN);
    expect(a.id).toMatch(/^AX-/);
  });
});

describe("GET /api/cron/reconcile", () => {
  const call = (authorization?: string) =>
    GET(new NextRequest("http://localhost:3000/api/cron/reconcile", { headers: authorization ? { authorization } : {} }), undefined);

  it("requires the cron secret", async () => {
    for (const header of [undefined, "Bearer wrong-secret", `Basic ${getEnv().CRON_SECRET}`, getEnv().CRON_SECRET]) {
      const res = await call(header);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="cron"');
      expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  it("runs the reconciliation with the secret and answers the summary, uncached", async () => {
    const res = await call(`Bearer ${getEnv().CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ provider: "mock", checked: expect.any(Number), errors: expect.any(Number) });
  });
});
