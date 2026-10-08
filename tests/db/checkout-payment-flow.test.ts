import { beforeAll, describe, expect, it } from "vitest";
import { cancelOrderPayment } from "@/lib/checkout/cancel";
import { retryPayment } from "@/lib/checkout/payment-attempt";
import { recordPaymentReturn, RETURN_SIGNATURE_MESSAGE } from "@/lib/checkout/return";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { activePaymentProvider, getPaymentProvider } from "@/lib/payments";
import { signMockReturn, type MockProvider } from "@/lib/payments/mock";
import { processPaymentEvent } from "@/lib/payments/webhook";
import { resolveOrderAccessFor, type OrderAccess } from "@/lib/orders/access";
import { verifyOrderToken } from "@/lib/orders/token";
import { authOf, makeCoupon, makeCustomer, markPaid, placeOrder, seedCatalog, uniq, type CatalogFixture, type CustomerFixture } from "./checkout-fixtures";

let cat: CatalogFixture;
let owner: CustomerFixture;

beforeAll(async () => {
  cat = await seedCatalog();
  owner = await makeCustomer({ role: "OWNER" });
});

type Placed = Awaited<ReturnType<typeof placeOrder>>;

async function guestOrder(): Promise<Placed> {
  return placeOrder(null, { email: `${uniq("pay")}@example.test`, items: [{ planId: cat.plans.annual.id, qty: 1 }] });
}

const access = (o: Placed): Promise<OrderAccess> => resolveOrderAccessFor(o.orderId, { auth: null, token: o.orderToken });
const latestPayment = (orderId: string) =>
  db.payment.findFirstOrThrow({ where: { orderId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
const statusOf = async (orderId: string) => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).status;

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const e = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

describe("payment return (client callback)", () => {
  it("moves the order to CONFIRMING with a valid signature and issues no licenses", async () => {
    const order = await guestOrder();
    const payment = await latestPayment(order.orderId);
    const providerPaymentId = `pay_mock_${uniq("p").replace(/-/g, "")}`;
    const result = await recordPaymentReturn(db, await access(order), {
      providerPaymentId,
      providerSignature: signMockReturn(payment.providerOrderId, providerPaymentId),
    });
    expect(result).toEqual({ status: "CONFIRMING" });
    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect([row.status, row.paidAt]).toEqual(["CONFIRMING", null]);
    expect(await latestPayment(order.orderId)).toMatchObject({ status: "AUTHORIZED", providerPaymentId });
    expect(await db.license.count({ where: { orderId: order.orderId } })).toBe(0);
    expect(await db.invoice.count({ where: { orderId: order.orderId } })).toBe(0);
  });

  it("rejects an invalid signature with 400 and changes nothing", async () => {
    const order = await guestOrder();
    const payment = await latestPayment(order.orderId);
    const forged = signMockReturn(payment.providerOrderId, "pay_other");
    const e = await apiError(recordPaymentReturn(db, await access(order), { providerPaymentId: "pay_mine", providerSignature: forged }));
    expect([e.status, e.code, e.message]).toEqual([400, "invalid_signature", RETURN_SIGNATURE_MESSAGE]);
    expect(await statusOf(order.orderId)).toBe("AWAITING_PAYMENT");
    expect(await latestPayment(order.orderId)).toMatchObject({ status: "CREATED", providerPaymentId: null });
  });

  it("confirms PENDING orders, leaves PAID orders, and reopens FAILED and CANCELED ones (a signed return means a paid payment)", async () => {
    const pending = await guestOrder();
    await db.order.update({ where: { id: pending.orderId }, data: { status: "PENDING" } });
    const p = await latestPayment(pending.orderId);
    const sign = (orderId: string) => signMockReturn(orderId, "pay_x1");
    expect(await recordPaymentReturn(db, await access(pending), { providerPaymentId: "pay_x1", providerSignature: sign(p.providerOrderId) })).toEqual({
      status: "CONFIRMING",
    });

    const paid = await guestOrder();
    await markPaid(paid.orderId);
    const pp = await latestPayment(paid.orderId);
    expect(await recordPaymentReturn(db, await access(paid), { providerPaymentId: "pay_x2", providerSignature: signMockReturn(pp.providerOrderId, "pay_x2") })).toEqual({
      status: "PAID",
    });

    const failed = await guestOrder();
    await db.order.update({ where: { id: failed.orderId }, data: { status: "FAILED", failReason: "Your bank declined the payment." } });
    await db.payment.updateMany({ where: { orderId: failed.orderId }, data: { status: "FAILED", failureReason: "Your bank declined the payment." } });
    const fp = await latestPayment(failed.orderId);
    const x3 = `pay_x3_${uniq("p").replace(/-/g, "")}`;
    expect(await recordPaymentReturn(db, await access(failed), { providerPaymentId: x3, providerSignature: signMockReturn(fp.providerOrderId, x3) })).toEqual({
      status: "CONFIRMING",
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: failed.orderId } })).toMatchObject({ status: "CONFIRMING", failReason: null });
    expect(await latestPayment(failed.orderId)).toMatchObject({ status: "AUTHORIZED", providerPaymentId: x3, failureReason: null });

    const canceled = await guestOrder();
    await cancelOrderPayment(db, await access(canceled));
    const cp = await latestPayment(canceled.orderId);
    const x4 = `pay_x4_${uniq("p").replace(/-/g, "")}`;
    expect(await recordPaymentReturn(db, await access(canceled), { providerPaymentId: x4, providerSignature: signMockReturn(cp.providerOrderId, x4) })).toEqual({
      status: "CONFIRMING",
    });
    expect(await latestPayment(canceled.orderId)).toMatchObject({ status: "AUTHORIZED", providerPaymentId: x4 });
  });

  it("fail then succeed inside one checkout: the failure webhook, then the signed return -> CONFIRMING, no retry, no stale failure email", async () => {
    const order = await guestOrder();
    const p = await latestPayment(order.orderId);
    const total = (await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).totalPaise;
    const [payA, payB] = [`pay_a_${uniq("p").replace(/-/g, "")}`, `pay_b_${uniq("p").replace(/-/g, "")}`];
    const mock = getPaymentProvider("mock") as MockProvider;
    const failure = mock.buildWebhook({ type: "payment.failed", providerOrderId: p.providerOrderId, providerPaymentId: payA, amountPaise: total }).event;
    expect(await processPaymentEvent("mock", failure)).toMatchObject({ result: "marked_failed" });
    expect(await statusOf(order.orderId)).toBe("FAILED");
    // The failure notice waits in the outbox (the mock sends at once, a real provider after 5 minutes).
    await db.outboxEmail.updateMany({ where: { dedupeKey: `payment_failed:${order.orderId}:${p.id}` }, data: { status: "PENDING" } });

    const result = await recordPaymentReturn(db, await access(order), { providerPaymentId: payB, providerSignature: signMockReturn(p.providerOrderId, payB) });
    expect(result).toEqual({ status: "CONFIRMING" });
    expect(await latestPayment(order.orderId)).toMatchObject({ status: "AUTHORIZED", providerPaymentId: payB });
    expect(await db.outboxEmail.count({ where: { dedupeKey: `payment_failed:${order.orderId}:${p.id}` } })).toBe(0);
    expect((await apiError(retryPayment(db, await access(order)))).code).toBe("not_retryable");

    // The capture webhook for pay_b fulfils the order.
    const capture = mock.buildWebhook({ type: "payment.captured", providerOrderId: p.providerOrderId, providerPaymentId: payB, amountPaise: total }).event;
    expect(await processPaymentEvent("mock", capture)).toMatchObject({ result: "fulfilled" });
    expect(await statusOf(order.orderId)).toBe("PAID");
  });

  it("refuses members who may not buy for the account", async () => {
    const order = await placeOrder(owner, { items: [{ planId: cat.plans.annual.id, qty: 1 }] });
    const viewer = await makeCustomer({ role: "VIEWER", accountId: owner.accountId });
    const viewerAccess = await resolveOrderAccessFor(order.orderId, { auth: authOf(viewer) });
    const p = await latestPayment(order.orderId);
    const e = await apiError(
      recordPaymentReturn(db, viewerAccess, { providerPaymentId: "pay_v", providerSignature: signMockReturn(p.providerOrderId, "pay_v") }),
    );
    expect(e.status).toBe(403);
    expect(await statusOf(order.orderId)).toBe("AWAITING_PAYMENT");
  });
});

describe("cancel", () => {
  it("cancels an order awaiting payment, idempotently", async () => {
    const order = await guestOrder();
    expect(await cancelOrderPayment(db, await access(order))).toEqual({ status: "CANCELED" });
    expect(await latestPayment(order.orderId)).toMatchObject({ status: "CANCELED" });
    expect(await cancelOrderPayment(db, await access(order))).toEqual({ status: "CANCELED" });
  });

  it("never cancels a payment that is confirming or paid", async () => {
    const order = await guestOrder();
    await db.order.update({ where: { id: order.orderId }, data: { status: "CONFIRMING" } });
    expect(await cancelOrderPayment(db, await access(order))).toEqual({ status: "CONFIRMING" });
    await markPaid(order.orderId);
    expect(await cancelOrderPayment(db, await access(order))).toEqual({ status: "PAID" });
  });
});

describe("retry", () => {
  it("opens a new attempt for a canceled order and keeps the amount", async () => {
    const order = await guestOrder();
    await cancelOrderPayment(db, await access(order));
    const before = await latestPayment(order.orderId);
    const now = new Date();
    const start = await retryPayment(db, await access(order), { now });
    expect(start.orderId).toBe(order.orderId);
    expect(start.checkout).toEqual({ kind: "mock", url: `/dev/mock-checkout?order=${order.orderId}&t=${start.orderToken}` });
    expect(verifyOrderToken(start.orderToken, order.orderId, now)).not.toBeNull();
    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId }, include: { payments: true } });
    expect([row.status, row.failReason]).toEqual(["AWAITING_PAYMENT", null]);
    expect(row.payments).toHaveLength(2);
    const latest = await latestPayment(order.orderId);
    expect(latest).toMatchObject({ status: "CREATED", amountPaise: row.totalPaise });
    expect(latest.providerOrderId).not.toBe(before.providerOrderId);
  });

  it("retries a failed order and clears the failure reason", async () => {
    const order = await guestOrder();
    await db.order.update({ where: { id: order.orderId }, data: { status: "FAILED", failReason: "Your bank declined the payment." } });
    await db.payment.updateMany({ where: { orderId: order.orderId }, data: { status: "FAILED" } });
    await retryPayment(db, await access(order));
    expect(await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({ status: "AWAITING_PAYMENT", failReason: null });
  });

  it("reopens the open attempt of an order still awaiting payment", async () => {
    const order = await guestOrder();
    const before = await latestPayment(order.orderId);
    await retryPayment(db, await access(order));
    expect(await db.payment.count({ where: { orderId: order.orderId } })).toBe(1);
    expect((await latestPayment(order.orderId)).id).toBe(before.id);
  });

  it("records the key id of every attempt and reopens only an attempt made with the active keys", async () => {
    const active = await activePaymentProvider();
    const order = await guestOrder();
    const first = await latestPayment(order.orderId);
    expect(first.providerKeyId).toBe(active.keyId);
    // An attempt made with other keys (test to live, another account) cannot be paid with these: a fresh one.
    await db.payment.update({ where: { id: first.id }, data: { providerKeyId: "rzp_test_OtherAccount01" } });
    await retryPayment(db, await access(order));
    const second = await latestPayment(order.orderId);
    expect(second.id).not.toBe(first.id);
    expect(second.providerKeyId).toBe(active.keyId);
    expect(await db.payment.count({ where: { orderId: order.orderId } })).toBe(2);
    // Attempts made before key ids were recorded (null) count as the active keys': reopened.
    await db.payment.update({ where: { id: second.id }, data: { providerKeyId: null } });
    const start = await retryPayment(db, await access(order));
    expect(await db.payment.count({ where: { orderId: order.orderId } })).toBe(2);
    expect(start.checkout).toEqual({ kind: "mock", url: `/dev/mock-checkout?order=${order.orderId}&t=${start.orderToken}` });
  });

  it("refuses orders that are paid or confirming (409 not_retryable)", async () => {
    const paid = await guestOrder();
    await markPaid(paid.orderId);
    const e = await apiError(retryPayment(db, await access(paid)));
    expect([e.status, e.code]).toEqual([409, "not_retryable"]);
    const confirming = await guestOrder();
    await db.order.update({ where: { id: confirming.orderId }, data: { status: "CONFIRMING" } });
    expect((await apiError(retryPayment(db, await access(confirming)))).code).toBe("not_retryable");
  });

  it("refuses to sell what is no longer available (409 order_unavailable)", async () => {
    const plan = await db.plan.create({
      data: { id: uniq("plan"), productId: cat.productId, type: "ANNUAL", name: "Soon archived", pricePaise: 100_000, interval: "YEAR", deviceLimit: 1, includes: [] },
    });
    const order = await placeOrder(null, { email: `${uniq("pay")}@example.test`, items: [{ planId: plan.id, qty: 1 }] });
    await cancelOrderPayment(db, await access(order));
    await db.plan.update({ where: { id: plan.id }, data: { archived: true } });
    const e = await apiError(retryPayment(db, await access(order)));
    expect([e.status, e.code]).toEqual([409, "order_unavailable"]);
    expect(await statusOf(order.orderId)).toBe("CANCELED");
  });

  it("refuses a new attempt while another attempt's payment is being confirmed (409 not_retryable)", async () => {
    const order = await guestOrder();
    await db.order.update({ where: { id: order.orderId }, data: { status: "FAILED" } });
    await db.payment.updateMany({ where: { orderId: order.orderId }, data: { status: "AUTHORIZED" } });
    expect((await apiError(retryPayment(db, await access(order)))).code).toBe("not_retryable");
    expect(await db.payment.count({ where: { orderId: order.orderId } })).toBe(1);
  });

  it("re-checks the order's coupon before a new attempt: paused, expired or used up -> 409 order_unavailable", async () => {
    const MIN = 60_000;
    const t0 = new Date();
    const couponOrder = async (code: string) =>
      placeOrder(null, { email: `${uniq("cpr")}@example.test`, items: [{ planId: cat.plans.annual.id, qty: 1 }], couponCode: code, now: t0 });

    const paused = await makeCoupon({ type: "PERCENT", value: 50 });
    const a = await couponOrder(paused);
    await cancelOrderPayment(db, await access(a));
    await db.coupon.update({ where: { code: paused }, data: { active: false } });
    expect((await apiError(retryPayment(db, await access(a), { now: new Date(t0.getTime() + MIN) }))).code).toBe("order_unavailable");
    expect(await statusOf(a.orderId)).toBe("CANCELED");
    expect(await db.payment.count({ where: { orderId: a.orderId } })).toBe(1);

    const ending = await makeCoupon({ type: "PERCENT", value: 50, endsAt: new Date(t0.getTime() + 10 * MIN) });
    const b = await couponOrder(ending);
    await cancelOrderPayment(db, await access(b));
    expect((await apiError(retryPayment(db, await access(b), { now: new Date(t0.getTime() + 11 * MIN) }))).code).toBe("order_unavailable");

    // Single use: the slot went to another order while this one was canceled.
    const single = await makeCoupon({ type: "PERCENT", value: 50, maxRedemptions: 1 });
    const c = await couponOrder(single);
    await cancelOrderPayment(db, await access(c));
    await couponOrder(single);
    expect((await apiError(retryPayment(db, await access(c), { now: new Date(t0.getTime() + MIN) }))).code).toBe("order_unavailable");

    // A coupon that is still fine: the retry goes ahead.
    const fine = await makeCoupon({ type: "PERCENT", value: 50, maxRedemptions: 1 });
    const d = await couponOrder(fine);
    await cancelOrderPayment(db, await access(d));
    await retryPayment(db, await access(d), { now: new Date(t0.getTime() + MIN) });
    expect(await statusOf(d.orderId)).toBe("AWAITING_PAYMENT");
  });

  it("gives a coupon order whose hold lapsed a fresh attempt instead of reopening the old one", async () => {
    const t0 = new Date();
    const code = await makeCoupon({ type: "PERCENT", value: 50, maxRedemptions: 5 });
    const order = await placeOrder(null, { email: `${uniq("cpr")}@example.test`, items: [{ planId: cat.plans.annual.id, qty: 1 }], couponCode: code, now: t0 });
    const first = await latestPayment(order.orderId);
    await retryPayment(db, await access(order), { now: new Date(t0.getTime() + 30 * 60_000) });
    expect((await latestPayment(order.orderId)).id).toBe(first.id);
    await retryPayment(db, await access(order), { now: new Date(t0.getTime() + 2 * 60 * 60_000) });
    expect(await db.payment.count({ where: { orderId: order.orderId } })).toBe(2);
    expect((await latestPayment(order.orderId)).id).not.toBe(first.id);
  });

  it("accepts the return of an earlier attempt after a retry", async () => {
    const order = await guestOrder();
    const first = await latestPayment(order.orderId);
    await cancelOrderPayment(db, await access(order));
    await retryPayment(db, await access(order));
    const result = await recordPaymentReturn(db, await access(order), {
      providerPaymentId: "pay_first_attempt",
      providerSignature: signMockReturn(first.providerOrderId, "pay_first_attempt"),
    });
    expect(result).toEqual({ status: "CONFIRMING" });
    expect(await db.payment.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ providerPaymentId: "pay_first_attempt" });
  });
});
