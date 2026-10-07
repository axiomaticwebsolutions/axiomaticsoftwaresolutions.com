import { randomBytes, randomInt } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { ItemKind, OrderStatus, Payment, Plan } from "@/generated/prisma/client";
import { POST } from "@/app/api/webhooks/payments/[provider]/route";
import { db } from "@/lib/db";
import { getLicenseKeySecrets } from "@/lib/env";
import { decryptLicenseKey } from "@/lib/licensing/crypto";
import { getPaymentProvider } from "@/lib/payments";
import { signMockReturn, signMockWebhook, type MockProvider, type MockWebhookInput } from "@/lib/payments/mock";
import { recordPaymentReturn } from "@/lib/checkout/return";
import { resolveOrderAccessFor } from "@/lib/orders/access";
import { signOrderToken } from "@/lib/orders/token";
import type { NormalizedEvent } from "@/lib/payments/types";
import { AMOUNT_MISMATCH_REASON, processPaymentEvent } from "@/lib/payments/webhook";
import { freshProductCode } from "../support/product-codes";

const tag = randomBytes(3).toString("hex");
let product: { id: string; code: string; name: string };
let plans: { annual: Plan; perUnit: Plan };

beforeAll(async () => {
  const category = await db.category.create({ data: { id: `wcat-${tag}`, name: "Test", tone: "peach", icon: "receipt_long" } });
  product = await db.product.create({
    data: {
      id: `wh-${tag}`,
      code: await freshProductCode(),
      name: `Webhook Billing ${tag}`,
      shortName: "Webhook",
      tagline: "Test product",
      summary: "Test product",
      icon: "receipt_long",
      categoryId: category.id,
      platforms: ["windows"],
      status: "PUBLISHED",
      content: {},
      relatedIds: [],
    },
    select: { id: true, code: true, name: true },
  });
  const plan = (p: Pick<Plan, "id" | "type" | "name" | "pricePaise"> & Partial<Pick<Plan, "interval" | "perUnit" | "deviceLimit">>) =>
    db.plan.create({ data: { includes: [], productId: product.id, deviceLimit: 1, ...p } });
  plans = {
    annual: await plan({ id: `wh-annual-${tag}`, type: "ANNUAL", name: "Annual license", interval: "YEAR", pricePaise: 499_900 }),
    perUnit: await plan({ id: `wh-sub-${tag}`, type: "SUBSCRIPTION", name: "Monthly", interval: "MONTH", perUnit: "terminal", pricePaise: 99_900 }),
  };
});

let seq = 0;
type ItemSpec = { plan: Plan; quantity?: number; kind?: ItemKind; target?: string };
type OrderSpec = {
  accountId?: string | null;
  placedByUserId?: string | null;
  items?: ItemSpec[];
  status?: OrderStatus;
  couponCode?: string | null;
  attempts?: number;
};
type TestOrder = { id: string; email: string; totalPaise: number; payments: Payment[] };

async function makeOrder(spec: OrderSpec = {}): Promise<TestOrder> {
  seq += 1;
  const id = `AX-${randomInt(10_000_000, 99_999_999)}`;
  const items = spec.items ?? [{ plan: plans.annual }];
  const subtotal = items.reduce((sum, i) => sum + i.plan.pricePaise * (i.quantity ?? 1), 0);
  const gst = Math.round((subtotal * 18) / 100);
  const totalPaise = subtotal + gst;
  const email = `buyer-${tag}-${seq}@example.test`;
  await db.order.create({
    data: {
      id,
      accountId: spec.accountId ?? null,
      placedByUserId: spec.placedByUserId ?? null,
      email,
      billing: { name: "Priya Sharma", email, phone: "9820000000", address: "Shop 4", city: "Pune", state: "Maharashtra", pin: "411004" },
      status: spec.status ?? "CONFIRMING",
      couponCode: spec.couponCode ?? null,
      subtotalPaise: subtotal,
      taxablePaise: subtotal,
      cgstPaise: Math.round(gst / 2),
      sgstPaise: gst - Math.round(gst / 2),
      totalPaise,
      placeOfSupply: "Maharashtra",
      items: {
        create: items.map((i) => ({
          planId: i.plan.id,
          kind: i.kind ?? "NEW",
          quantity: i.quantity ?? 1,
          unitPricePaise: i.plan.pricePaise,
          taxablePaise: i.plan.pricePaise * (i.quantity ?? 1),
          taxPaise: Math.round((i.plan.pricePaise * (i.quantity ?? 1) * 18) / 100),
          targetLicenseId: i.target ?? null,
        })),
      },
    },
  });
  const attempts = spec.attempts ?? 1;
  const payments: Payment[] = [];
  for (let i = 0; i < attempts; i += 1) {
    payments.push(
      await db.payment.create({
        data: {
          orderId: id,
          provider: "mock",
          providerOrderId: `order_mock_${tag}${seq}x${i}`,
          amountPaise: totalPaise,
          createdAt: new Date(Date.now() - (attempts - i) * 60_000),
        },
      }),
    );
  }
  return { id, email, totalPaise, payments };
}

/** A business account with an active owner, an active viewer and an invited member (who gets no notification). */
async function makeAccount(): Promise<{ accountId: string; ownerId: string; activeUserIds: string[] }> {
  seq += 1;
  const account = await db.businessAccount.create({ data: { legalName: `Store ${tag}-${seq}` } });
  const user = (role: string) =>
    db.user.create({ data: { email: `${role}-${tag}-${seq}@example.test`, name: `${role} ${seq}`, emailVerifiedAt: new Date() } });
  const owner = await user("owner");
  const viewer = await user("viewer");
  const invited = await user("invited");
  await db.accountMember.createMany({
    data: [
      { accountId: account.id, userId: owner.id, role: "OWNER" },
      { accountId: account.id, userId: viewer.id, role: "VIEWER" },
      { accountId: account.id, userId: invited.id, role: "VIEWER", status: "INVITED" },
    ],
  });
  return { accountId: account.id, ownerId: owner.id, activeUserIds: [owner.id, viewer.id] };
}

const mock = () => getPaymentProvider("mock") as MockProvider;
let paySeq = 0;
const payId = () => `pay_mock_${tag}${(paySeq += 1)}`;

function captured(order: TestOrder, over: Partial<MockWebhookInput> = {}, attempt = order.payments.length - 1): MockWebhookInput {
  return {
    type: "payment.captured",
    providerOrderId: order.payments[attempt]!.providerOrderId,
    providerPaymentId: payId(),
    amountPaise: order.totalPaise,
    method: "UPI",
    ...over,
  } as MockWebhookInput;
}

/** A signed NormalizedEvent as the mock provider would deliver it. */
function event(input: MockWebhookInput): NormalizedEvent {
  return mock().buildWebhook(input).event;
}

async function deliver(rawBody: string, headers: Headers): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string | null }> {
  const req = new NextRequest("http://localhost:3000/api/webhooks/payments/mock", { method: "POST", headers, body: rawBody });
  const res = await POST(req, { params: Promise.resolve({ provider: "mock" }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cacheControl: res.headers.get("cache-control") };
}

const licensesOf = (orderId: string) => db.license.findMany({ where: { orderId }, orderBy: { id: "asc" } });
const deliveriesOf = (eventId: string) => db.webhookDelivery.findMany({ where: { eventId }, orderBy: { receivedAt: "asc" } });
const orderRow = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { invoice: true, payments: { orderBy: { createdAt: "asc" } } } });
const outboxFor = (keys: string[]) => db.outboxEmail.findMany({ where: { dedupeKey: { in: keys } } });
const FULL_KEY = /[A-Z]{3}(?:-[A-HJ-NP-Z2-9]{4}){4}/;

describe("signature", () => {
  it("bad signature: 401, a stored invalid_signature delivery, no state change", async () => {
    const order = await makeOrder();
    const { rawBody, event: ev } = mock().buildWebhook(captured(order));
    const before = await db.webhookDelivery.count({ where: { result: "invalid_signature" } });
    const forged = new Headers({ "content-type": "application/json", "x-mock-signature": "0".repeat(64) });
    const res = await deliver(rawBody, forged);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: "invalid_signature", message: expect.any(String) } });
    expect(res.cacheControl).toBe("no-store");

    const unsigned = await deliver(rawBody, new Headers({ "content-type": "application/json" }));
    expect(unsigned.status).toBe(401);

    expect(await db.webhookDelivery.count({ where: { result: "invalid_signature", signatureOk: false } })).toBe(before + 2);
    expect(await db.webhookEvent.findUnique({ where: { provider_id: { provider: "mock", id: ev.id } } })).toBeNull();
    const row = await orderRow(order.id);
    expect(row.status).toBe("CONFIRMING");
    expect(row.payments[0]?.status).toBe("CREATED");
    expect(row.invoice).toBeNull();
    expect(await licensesOf(order.id)).toHaveLength(0);
  });

  it("a tampered body (amount changed after signing) is rejected", async () => {
    const order = await makeOrder();
    const { rawBody, headers } = mock().buildWebhook(captured(order));
    const tampered = rawBody.replace(`"amountPaise":${order.totalPaise}`, `"amountPaise":${order.totalPaise - 1}`);
    expect(tampered).not.toBe(rawBody);
    expect((await deliver(tampered, headers)).status).toBe(401);
    expect((await orderRow(order.id)).status).toBe("CONFIRMING");
  });

  it("ignored event types and unreadable signed bodies answer 200 without touching orders", async () => {
    const order = await makeOrder();
    const withSig = (body: string) => new Headers({ "content-type": "application/json", "x-mock-signature": signMockWebhook(body) });
    const ignored = JSON.stringify({ ...captured(order), id: `evt_ign_${tag}`, type: "payment.authorized", currency: "INR" });
    expect(await deliver(ignored, withSig(ignored))).toMatchObject({ status: 200, body: { result: "ignored" } });
    const junk = "{\"id\":";
    expect(await deliver(junk, withSig(junk))).toMatchObject({ status: 200, body: { result: "invalid_payload" } });
    expect((await orderRow(order.id)).status).toBe("CONFIRMING");
  });
});

describe("payment.captured", () => {
  it("valid event: PAID, invoice, one license per NEW item, records, notifications and outbox emails once", async () => {
    const { accountId, ownerId, activeUserIds } = await makeAccount();
    const order = await makeOrder({ accountId, placedByUserId: ownerId, items: [{ plan: plans.annual }, { plan: plans.perUnit, quantity: 3 }] });
    const { rawBody, headers, event: ev } = mock().buildWebhook(captured(order, { method: "Card" }));
    const res = await deliver(rawBody, headers);
    expect(res).toMatchObject({ status: 200, body: { result: "fulfilled" }, cacheControl: "no-store" });

    const row = await orderRow(order.id);
    expect(row.status).toBe("PAID");
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(row.failReason).toBeNull();
    expect(row.payments[0]).toMatchObject({ status: "CAPTURED", providerPaymentId: ev.providerPaymentId, method: "Card" });
    expect(row.payments[0]?.capturedAt).toBeInstanceOf(Date);
    expect(row.invoice?.number).toMatch(/^AXS\/\d{2}-\d{2}\/\d{4,6}$/);
    expect(row.invoice?.issuedAt.getTime()).toBe(row.paidAt?.getTime());
    expect(row.invoice?.sac).toBe("997331");
    expect(row.invoice?.seller).toMatchObject({ legalName: expect.any(String), gstin: expect.any(String), state: expect.any(String) });

    const licenses = await licensesOf(order.id);
    expect(licenses).toHaveLength(2);
    expect(licenses.every((l) => l.accountId === accountId && l.status === "ACTIVE")).toBe(true);
    expect(licenses.map((l) => l.deviceLimit).sort()).toEqual([1, 3]);
    const items = await db.orderItem.findMany({ where: { orderId: order.id } });
    expect(items.every((i) => i.fulfilledAt?.getTime() === row.paidAt?.getTime() && i.issuedLicenseId !== null)).toBe(true);

    const stored = await db.webhookEvent.findUniqueOrThrow({ where: { provider_id: { provider: "mock", id: ev.id } } });
    expect(stored).toMatchObject({ result: "fulfilled", orderId: order.id, type: "payment.captured" });
    expect(stored.payload).toEqual({
      id: ev.id,
      type: "payment.captured",
      providerOrderId: ev.providerOrderId,
      providerPaymentId: ev.providerPaymentId,
      amountPaise: order.totalPaise,
      currency: "INR",
      method: "Card",
    });
    expect(await deliveriesOf(ev.id)).toMatchObject([{ result: "fulfilled", signatureOk: true, orderId: order.id }]);

    expect(await db.auditLog.findMany({ where: { targetId: order.id, action: "Webhook processed" } })).toMatchObject([
      { actorRole: "system", actorId: null, target: `payment.captured · ${order.id}`, targetType: "order", detail: expect.stringMatching(/^fulfilled · Invoice /) },
    ]);
    expect(await db.accountActivity.findMany({ where: { accountId } })).toMatchObject([
      { action: "Placed order", target: order.id, kind: "billing", actorId: ownerId, actorName: expect.stringContaining("owner") },
    ]);
    const notes = await db.notification.findMany({ where: { title: `Payment confirmed for ${order.id}` } });
    expect(notes.map((n) => n.userId).sort()).toEqual([...activeUserIds].sort());
    expect(notes[0]).toMatchObject({ kind: "billing", href: `/orders/${order.id}` });

    const keys = [`order_confirmation:${order.id}`, ...licenses.map((l) => `license_issued:${l.id}`)];
    const emails = await outboxFor(keys);
    expect(emails.map((e) => e.dedupeKey).sort()).toEqual([...keys].sort());
    expect(emails.every((e) => e.to === order.email && e.status === "PENDING")).toBe(true);
    const encKey = getLicenseKeySecrets().encKey;
    for (const email of emails) {
      expect(`${email.html}\n${email.text}`).not.toMatch(FULL_KEY);
      for (const l of licenses) expect(email.html).not.toContain(decryptLicenseKey(l.keyCiphertext, encKey));
      expect(email.html).toContain(`/orders/${order.id}?t=`);
    }
    const licenseMail = emails.find((e) => e.dedupeKey === `license_issued:${licenses[0]?.id}`);
    expect(licenseMail?.text).toContain(licenses[0]?.keyLast4 ?? "????");
  });

  it("the same event twice sequentially: duplicate_ignored, still one license per item, one invoice, emails once", async () => {
    const order = await makeOrder({ items: [{ plan: plans.annual }] });
    const { rawBody, headers, event: ev } = mock().buildWebhook(captured(order));
    expect((await deliver(rawBody, headers)).body).toEqual({ result: "fulfilled" });
    expect((await deliver(rawBody, headers)).body).toEqual({ result: "duplicate_ignored" });
    expect(await processPaymentEvent("mock", ev)).toEqual({ status: 200, result: "duplicate_ignored" });

    expect(await licensesOf(order.id)).toHaveLength(1);
    expect(await db.invoice.count({ where: { orderId: order.id } })).toBe(1);
    expect(await outboxFor([`order_confirmation:${order.id}`])).toHaveLength(1);
    expect(await db.auditLog.count({ where: { targetId: order.id, action: "Webhook processed" } })).toBe(1);
    expect((await deliveriesOf(ev.id)).map((d) => d.result)).toEqual(["fulfilled", "duplicate_ignored", "duplicate_ignored"]);
  });

  it("the same event twice concurrently: one fulfilled, one duplicate_ignored, exactly one license per item", async () => {
    const order = await makeOrder({ items: [{ plan: plans.annual }, { plan: plans.perUnit, quantity: 2 }] });
    const { rawBody, headers, event: ev } = mock().buildWebhook(captured(order));
    const results = await Promise.all([deliver(rawBody, headers), deliver(rawBody, headers), processPaymentEvent("mock", ev)]);
    expect(results.map((r) => ("body" in r ? r.body.result : r.result)).sort()).toEqual(["duplicate_ignored", "duplicate_ignored", "fulfilled"]);
    expect(await licensesOf(order.id)).toHaveLength(2);
    expect(await db.invoice.count({ where: { orderId: order.id } })).toBe(1);
    const licenses = await licensesOf(order.id);
    expect(await outboxFor([`order_confirmation:${order.id}`, ...licenses.map((l) => `license_issued:${l.id}`)])).toHaveLength(3);
    expect((await orderRow(order.id)).status).toBe("PAID");
  });

  it("two different events for the same payment: already_paid, no new licenses", async () => {
    const order = await makeOrder();
    const first = event(captured(order));
    expect(await processPaymentEvent("mock", first)).toEqual({ status: 200, result: "fulfilled" });
    // Razorpay sends payment.captured and order.paid for one payment, with different event ids.
    const second = event({ ...captured(order), providerPaymentId: first.providerPaymentId });
    expect(second.id).not.toBe(first.id);
    expect(await processPaymentEvent("mock", second)).toEqual({ status: 200, result: "already_paid" });
    expect(await licensesOf(order.id)).toHaveLength(1);
    expect(await db.invoice.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { targetId: order.id, action: "Duplicate payment captured" } })).toBe(0);
  });

  it("a second payment captured after the order is paid is recorded and flagged for a refund, nothing else", async () => {
    const order = await makeOrder({ attempts: 2 });
    expect(await processPaymentEvent("mock", event(captured(order, {}, 1)))).toMatchObject({ result: "fulfilled" });
    const late = event(captured(order, {}, 0));
    expect(await processPaymentEvent("mock", late)).toMatchObject({ result: "already_paid" });
    const row = await orderRow(order.id);
    expect(row.status).toBe("PAID");
    expect(row.payments.map((p) => p.status)).toEqual(["CAPTURED", "CAPTURED"]);
    expect(row.payments[0]?.providerPaymentId).toBe(late.providerPaymentId);
    expect(await licensesOf(order.id)).toHaveLength(1);
    expect(await db.auditLog.count({ where: { targetId: order.id, action: "Duplicate payment captured" } })).toBe(1);
  });

  it("amount mismatch: REVIEW, payment recorded, no licenses, no invoice, no emails", async () => {
    const order = await makeOrder();
    const ev = event(captured(order, { amountPaise: order.totalPaise - 100 }));
    expect(await processPaymentEvent("mock", ev)).toEqual({ status: 200, result: "amount_mismatch" });
    const row = await orderRow(order.id);
    expect(row).toMatchObject({ status: "REVIEW", failReason: AMOUNT_MISMATCH_REASON, paidAt: null, invoice: null });
    expect(row.payments[0]).toMatchObject({ status: "CAPTURED", providerPaymentId: ev.providerPaymentId });
    expect(await licensesOf(order.id)).toHaveLength(0);
    expect(await outboxFor([`order_confirmation:${order.id}`])).toHaveLength(0);
    expect(await db.auditLog.count({ where: { targetId: order.id, action: "Flagged order for review" } })).toBe(1);
    // A later, correct capture leaves the order for the person reviewing it.
    expect(await processPaymentEvent("mock", event(captured(order)))).toMatchObject({ result: "order_in_review" });
    expect(await licensesOf(order.id)).toHaveLength(0);
  });

  it("currency mismatch: REVIEW, no licenses", async () => {
    const order = await makeOrder();
    const ev: NormalizedEvent = { ...event(captured(order)), currency: "USD" };
    expect(await processPaymentEvent("mock", ev)).toMatchObject({ result: "amount_mismatch" });
    expect((await orderRow(order.id)).status).toBe("REVIEW");
    expect(await licensesOf(order.id)).toHaveLength(0);
  });

  it("captured after FAILED or CANCELED still pays the order (the money was taken)", async () => {
    for (const status of ["FAILED", "CANCELED"] as const) {
      const order = await makeOrder({ status });
      expect(await processPaymentEvent("mock", event(captured(order)))).toMatchObject({ result: "fulfilled" });
      expect((await orderRow(order.id)).status).toBe("PAID");
    }
  });

  it("uses the provider's event time as paidAt unless it is in the future", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 90_000);
    const a = await makeOrder();
    await processPaymentEvent("mock", { ...event(captured(a)), occurredAt: past }, { now });
    expect((await orderRow(a.id)).paidAt?.getTime()).toBe(past.getTime());
    const b = await makeOrder();
    await processPaymentEvent("mock", { ...event(captured(b)), occurredAt: new Date(now.getTime() + 3_600_000) }, { now });
    expect((await orderRow(b.id)).paidAt?.getTime()).toBe(now.getTime());
  });

  it("an unknown provider order: unknown_order, recorded once", async () => {
    const ev = event({ type: "payment.captured", providerOrderId: `order_mock_unknown${tag}`, providerPaymentId: payId(), amountPaise: 100 });
    expect(await processPaymentEvent("mock", ev)).toEqual({ status: 200, result: "unknown_order" });
    expect(await processPaymentEvent("mock", ev)).toEqual({ status: 200, result: "duplicate_ignored" });
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { provider_id: { provider: "mock", id: ev.id } } })).toMatchObject({
      result: "unknown_order",
      orderId: null,
    });
  });

  it("a payment of another provider is unknown to this one", async () => {
    const order = await makeOrder();
    expect(await processPaymentEvent("razorpay", event(captured(order)))).toMatchObject({ result: "unknown_order" });
    expect((await orderRow(order.id)).status).toBe("CONFIRMING");
  });

  it("a fulfilment error rolls back, then marks the order REVIEW and records fulfilment_failed", async () => {
    const { accountId } = await makeAccount();
    const order = await makeOrder({
      accountId,
      items: [{ plan: plans.annual }, { plan: plans.annual, kind: "RENEWAL", target: `LIC-missing-${tag}` }],
    });
    const ev = event(captured(order));
    expect(await processPaymentEvent("mock", ev)).toEqual({ status: 200, result: "fulfilment_failed" });
    const row = await orderRow(order.id);
    expect(row.status).toBe("REVIEW");
    expect(row.failReason).toContain("target_not_found");
    expect(row.paidAt).toBeNull();
    expect(row.invoice).toBeNull();
    expect(row.payments[0]).toMatchObject({ status: "CAPTURED", providerPaymentId: ev.providerPaymentId });
    // The license issued for the first item was rolled back with everything else.
    expect(await licensesOf(order.id)).toHaveLength(0);
    expect(await db.orderItem.count({ where: { orderId: order.id, fulfilledAt: { not: null } } })).toBe(0);
    expect(await outboxFor([`order_confirmation:${order.id}`])).toHaveLength(0);
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { provider_id: { provider: "mock", id: ev.id } } })).toMatchObject({
      result: "fulfilment_failed",
    });
    expect(await db.auditLog.count({ where: { targetId: order.id, action: "Flagged order for review" } })).toBe(1);
    expect(await processPaymentEvent("mock", ev)).toEqual({ status: 200, result: "duplicate_ignored" });
    expect((await deliveriesOf(ev.id)).map((d) => d.result)).toEqual(["fulfilment_failed", "duplicate_ignored"]);
  });

  it("redeems the coupon once and honours a paid order even when the coupon is exhausted", async () => {
    const code = `T${tag.toUpperCase()}`;
    const day = 86_400_000;
    await db.coupon.create({
      data: {
        code,
        type: "PERCENT",
        value: 10,
        label: "10% off",
        productIds: [],
        planTypes: [],
        startsAt: new Date(Date.now() - day),
        endsAt: new Date(Date.now() + day),
        maxRedemptions: 1,
        redemptions: 1,
      },
    });
    const order = await makeOrder({ couponCode: code });
    const ev = event(captured(order));
    expect(await processPaymentEvent("mock", ev)).toMatchObject({ result: "fulfilled" });
    expect(await processPaymentEvent("mock", event({ ...captured(order), providerPaymentId: ev.providerPaymentId }))).toMatchObject({
      result: "already_paid",
    });
    expect((await orderRow(order.id)).status).toBe("PAID");
    expect(await db.couponRedemption.findMany({ where: { orderId: order.id } })).toMatchObject([{ couponCode: code, accountId: null }]);
    expect((await db.coupon.findUniqueOrThrow({ where: { code } })).redemptions).toBe(2);
  });

  it("a guest order issues unclaimed licenses and emails the order address, with no account records", async () => {
    const order = await makeOrder({ accountId: null });
    expect(await processPaymentEvent("mock", event(captured(order)))).toMatchObject({ result: "fulfilled" });
    const [license] = await licensesOf(order.id);
    expect(license?.accountId).toBeNull();
    expect(await db.notification.count({ where: { title: `Payment confirmed for ${order.id}` } })).toBe(0);
    expect(await db.accountActivity.count({ where: { target: order.id } })).toBe(0);
    expect(await outboxFor([`order_confirmation:${order.id}`, `license_issued:${license?.id}`])).toHaveLength(2);
  });
});

function failed(order: TestOrder, attempt = order.payments.length - 1, reason?: string): MockWebhookInput {
  return {
    type: "payment.failed",
    providerOrderId: order.payments[attempt]!.providerOrderId,
    providerPaymentId: payId(),
    amountPaise: order.totalPaise,
    method: "UPI",
    ...(reason ? { failureReason: reason } : {}),
  };
}

describe("payment.failed", () => {
  it("does not downgrade a PAID order", async () => {
    const order = await makeOrder();
    expect(await processPaymentEvent("mock", event(captured(order)))).toMatchObject({ result: "fulfilled" });
    expect(await processPaymentEvent("mock", event(failed(order)))).toEqual({ status: 200, result: "already_paid" });
    const row = await orderRow(order.id);
    expect(row.status).toBe("PAID");
    expect(row.payments[0]?.status).toBe("CAPTURED");
    expect(await licensesOf(order.id)).toHaveLength(1);
  });

  it("fails the order only for the latest attempt, with the reason and a payment_failed email", async () => {
    const order = await makeOrder({ status: "AWAITING_PAYMENT", attempts: 2 });
    const [older, latest] = order.payments;
    expect(await processPaymentEvent("mock", event(failed(order, 0)))).toMatchObject({ result: "stale_attempt" });
    let row = await orderRow(order.id);
    expect(row.status).toBe("AWAITING_PAYMENT");
    expect(row.payments[0]).toMatchObject({ id: older?.id, status: "FAILED" });

    expect(await processPaymentEvent("mock", event(failed(order, 1, "Your bank declined the payment.")))).toMatchObject({
      result: "marked_failed",
    });
    row = await orderRow(order.id);
    expect(row).toMatchObject({ status: "FAILED", failReason: "Your bank declined the payment." });
    expect(row.payments[1]).toMatchObject({ id: latest?.id, status: "FAILED" });
    const [mail] = await outboxFor([`payment_failed:${order.id}:${latest?.id}`]);
    expect(mail).toMatchObject({ to: order.email, status: "PENDING", templateId: "payment_failed" });
    expect(mail?.html).toContain(`/orders/${order.id}?t=`);

    // The customer pays after all: the order is paid and the unsent failure notice is withdrawn.
    expect(await processPaymentEvent("mock", event(captured(order)))).toMatchObject({ result: "fulfilled" });
    expect((await orderRow(order.id)).status).toBe("PAID");
    expect(await outboxFor([`payment_failed:${order.id}:${latest?.id}`])).toHaveLength(0);
  });

  it("uses the default reason when the provider gives none", async () => {
    const order = await makeOrder({ status: "PENDING" });
    expect(await processPaymentEvent("mock", event(failed(order)))).toMatchObject({ result: "marked_failed" });
    expect((await orderRow(order.id)).failReason).toBe("Your bank declined the payment.");
  });
});

describe("refund.processed", () => {
  it("marks refunds processed: PARTIALLY_REFUNDED, then REFUNDED when they reach the total", async () => {
    const order = await makeOrder();
    const paid = event(captured(order));
    await processPaymentEvent("mock", paid);
    const payment = order.payments[0]!;
    const half = Math.floor(order.totalPaise / 2);
    const refund = (suffix: string, amountPaise: number) =>
      db.refund.create({
        data: { paymentId: payment.id, providerRefundId: `rfnd_mock_${tag}${suffix}${seq}`, amountPaise, reason: "Customer request", createdById: "staff-test" },
      });
    const first = await refund("a", half);
    const refundEvent = (r: { providerRefundId: string | null; amountPaise: number }) =>
      event({
        type: "refund.processed",
        providerOrderId: payment.providerOrderId,
        providerPaymentId: paid.providerPaymentId,
        providerRefundId: r.providerRefundId ?? undefined,
        amountPaise: r.amountPaise,
      });
    expect(await processPaymentEvent("mock", refundEvent(first))).toMatchObject({ result: "refund_processed" });
    let row = await orderRow(order.id);
    expect(row.status).toBe("PARTIALLY_REFUNDED");
    expect(row.refundedAt).toBeNull();
    expect(await db.refund.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "PROCESSED", processedAt: expect.any(Date) });

    const second = await refund("b", order.totalPaise - half);
    expect(await processPaymentEvent("mock", refundEvent(second))).toMatchObject({ result: "refund_processed" });
    row = await orderRow(order.id);
    expect(row.status).toBe("REFUNDED");
    expect(row.refundedAt).toBeInstanceOf(Date);
    expect(row.payments[0]?.status).toBe("REFUNDED");
    // Licenses are revoked by the admin refund action (Phase 6), not here.
    expect((await licensesOf(order.id)).every((l) => l.status === "ACTIVE")).toBe(true);
    expect(await db.auditLog.count({ where: { targetId: order.id, action: "Refund processed" } })).toBe(2);
  });

  it("an unknown refund of the paying payment (made in the provider dashboard) is not recorded and flags the order", async () => {
    const order = await makeOrder();
    const paid = event(captured(order));
    await processPaymentEvent("mock", paid);
    const ev = event({
      type: "refund.processed",
      providerOrderId: order.payments[0]!.providerOrderId,
      providerPaymentId: paid.providerPaymentId,
      providerRefundId: `rfnd_mock_unknown${tag}`,
      amountPaise: 100,
    });
    expect(await processPaymentEvent("mock", ev)).toMatchObject({ result: "unknown_refund" });
    expect(await db.refund.count({ where: { providerRefundId: `rfnd_mock_unknown${tag}` } })).toBe(0);
    // No credit note and the licenses untouched: staff check the order (lib/payments/webhook.ts recordExternalRefund).
    const row = await orderRow(order.id);
    expect(row.status).toBe("REVIEW");
    expect(row.failReason).toContain("outside the console");
  });
});

describe("several payments inside one provider order (Razorpay's in-checkout retry)", () => {
  const returnFor = async (order: TestOrder, providerPaymentId: string, attempt = order.payments.length - 1) => {
    const access = await resolveOrderAccessFor(order.id, { auth: null, token: signOrderToken(order.id, order.email) });
    const providerOrderId = order.payments[attempt]!.providerOrderId;
    return recordPaymentReturn(db, access, { providerPaymentId, providerSignature: signMockReturn(providerOrderId, providerPaymentId) });
  };

  it("a late failure of an earlier payment leaves a CONFIRMING order and its verified payment alone; the capture then fulfils", async () => {
    const order = await makeOrder({ status: "AWAITING_PAYMENT" });
    const [payA, payB] = [payId(), payId()];
    expect(await returnFor(order, payB)).toEqual({ status: "CONFIRMING" });
    const late = event({ ...failed(order), providerPaymentId: payA });
    expect(await processPaymentEvent("mock", late)).toEqual({ status: 200, result: "stale_attempt" });
    let row = await orderRow(order.id);
    expect(row).toMatchObject({ status: "CONFIRMING", failReason: null });
    expect(row.payments[0]).toMatchObject({ status: "AUTHORIZED", providerPaymentId: payB });
    expect(await outboxFor([`payment_failed:${order.id}:${order.payments[0]!.id}`])).toHaveLength(0);

    expect(await processPaymentEvent("mock", event({ ...captured(order), providerPaymentId: payB }))).toMatchObject({ result: "fulfilled" });
    row = await orderRow(order.id);
    expect(row.status).toBe("PAID");
    expect(await licensesOf(order.id)).toHaveLength(1);
  });

  it("a failure of the very payment whose return was verified still fails the order", async () => {
    const order = await makeOrder({ status: "AWAITING_PAYMENT" });
    const pay = payId();
    await returnFor(order, pay);
    expect(await processPaymentEvent("mock", event({ ...failed(order), providerPaymentId: pay }))).toMatchObject({ result: "marked_failed" });
    expect(await orderRow(order.id)).toMatchObject({ status: "FAILED", payments: [expect.objectContaining({ status: "FAILED" })] });
  });

  it("the latest attempt failing while an earlier attempt's return was verified leaves the order to that payment", async () => {
    const order = await makeOrder({ status: "AWAITING_PAYMENT", attempts: 2 });
    const verified = payId();
    expect(await returnFor(order, verified, 0)).toEqual({ status: "CONFIRMING" });
    expect(await processPaymentEvent("mock", event(failed(order, 1)))).toMatchObject({ result: "stale_attempt" });
    const row = await orderRow(order.id);
    expect(row.status).toBe("CONFIRMING");
    expect(row.payments.map((p) => p.status)).toEqual(["AUTHORIZED", "FAILED"]);
  });

  it("failure first, then the verified return of the next payment: the order goes back to CONFIRMING and pays", async () => {
    const order = await makeOrder({ status: "AWAITING_PAYMENT" });
    const [payA, payB] = [payId(), payId()];
    expect(await processPaymentEvent("mock", event({ ...failed(order), providerPaymentId: payA }))).toMatchObject({ result: "marked_failed" });
    expect(await returnFor(order, payB)).toEqual({ status: "CONFIRMING" });
    // The failure of pay_a is redelivered later (another event id): nothing changes.
    expect(await processPaymentEvent("mock", event({ ...failed(order), providerPaymentId: payA }))).toMatchObject({ result: "stale_attempt" });
    expect((await orderRow(order.id)).status).toBe("CONFIRMING");
    expect(await processPaymentEvent("mock", event({ ...captured(order), providerPaymentId: payB }))).toMatchObject({ result: "fulfilled" });
  });
});

describe("refund of a duplicate payment", () => {
  it("leaves the paid order PAID; a refund of the paying payment still refunds it", async () => {
    const order = await makeOrder({ attempts: 2 });
    const paying = event(captured(order, {}, 1));
    expect(await processPaymentEvent("mock", paying)).toMatchObject({ result: "fulfilled" });
    const duplicate = event(captured(order, {}, 0));
    expect(await processPaymentEvent("mock", duplicate)).toMatchObject({ result: "already_paid" });
    const refundOf = async (attempt: number, providerPaymentId: string | undefined) => {
      const payment = order.payments[attempt]!;
      const refund = await db.refund.create({
        data: { paymentId: payment.id, providerRefundId: `rfnd_dup_${tag}${(paySeq += 1)}`, amountPaise: order.totalPaise, reason: "Duplicate payment", createdById: "staff-test" },
      });
      return processPaymentEvent(
        "mock",
        event({ type: "refund.processed", providerOrderId: payment.providerOrderId, providerPaymentId, providerRefundId: refund.providerRefundId ?? undefined, amountPaise: order.totalPaise }),
      );
    };

    expect(await refundOf(0, duplicate.providerPaymentId)).toMatchObject({ result: "refund_processed" });
    let row = await orderRow(order.id);
    expect(row).toMatchObject({ status: "PAID", refundedAt: null });
    expect(row.payments.map((p) => p.status)).toEqual(["REFUNDED", "CAPTURED"]);
    const [audit] = await db.auditLog.findMany({ where: { targetId: order.id, action: "Refund processed" } });
    expect(audit?.detail).toContain("did not pay the order");

    expect(await refundOf(1, paying.providerPaymentId)).toMatchObject({ result: "refund_processed" });
    row = await orderRow(order.id);
    expect(row.status).toBe("REFUNDED");
    expect(row.refundedAt).toBeInstanceOf(Date);
  });
});

describe("customer names in order emails", () => {
  it("greets a billing name that carries a link as 'there' in every order email", async () => {
    const order = await makeOrder({ status: "AWAITING_PAYMENT", attempts: 2 });
    const name = "Your account is on hold. Verify at https://axiomatic-billing.example/secure";
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    await db.order.update({ where: { id: order.id }, data: { billing: { ...(row.billing as Record<string, unknown>), name } } });
    expect(await processPaymentEvent("mock", event(failed(order, 1)))).toMatchObject({ result: "marked_failed" });
    expect(await processPaymentEvent("mock", event(captured(order, {}, 1)))).toMatchObject({ result: "fulfilled" });
    const [license] = await licensesOf(order.id);
    const mails = await db.outboxEmail.findMany({ where: { dedupeKey: { in: [`order_confirmation:${order.id}`, `license_issued:${license?.id}`] } } });
    expect(mails).toHaveLength(2);
    for (const mail of mails) {
      expect(mail.html).toContain("Hi there,");
      expect(mail.html).not.toContain("axiomatic-billing");
      expect(mail.text).not.toContain("axiomatic-billing");
    }
  });
});
