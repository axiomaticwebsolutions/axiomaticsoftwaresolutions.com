/**
 * Admin records PART B (docs/admin-records-design.md B12.2, database): editing an unpaid order re-prices it like
 * checkout, replaces its lines and closes (supersedes) its open payment attempts, so the next payment uses a fresh
 * provider order at the new total and a late capture of an old attempt goes to REVIEW; paid, settling and
 * staff-cancelled orders are refused; a staff cancel is final for the customer; payment links are re-shared.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

import type { User } from "@/generated/prisma/client";
import * as cancelRoute from "@/app/api/admin/orders/[id]/cancel/route";
import * as linkRoute from "@/app/api/admin/orders/[id]/payment-link/route";
import * as detailRoute from "@/app/api/admin/orders/[id]/route";
import { createPaymentLinkOrder, type PaymentLinkOrderResult } from "@/lib/admin/orders/create";
import { updateUnpaidOrder } from "@/lib/admin/orders/edit";
import { orderCreateBody, orderPatchBody } from "@/lib/admin/orders/schemas";
import { actorFromStaff } from "@/lib/audit";
import { CHECKOUT_TERMS_VERSION } from "@/lib/checkout/create-order";
import { retryPayment } from "@/lib/checkout/payment-attempt";
import { priceCart } from "@/lib/checkout/quote";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { resolveOrderAccessFor } from "@/lib/orders/access";
import { buildOrderStatus } from "@/lib/orders/status";
import { getPaymentProvider } from "@/lib/payments";
import { mockCapture } from "@/lib/payments/mock";
import { processPaymentEvent, SUPERSEDED_ATTEMPT_REASON } from "@/lib/payments/webhook";
import { callRoute, errorCodeOf, makeAdminCallers, makeStaff, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import {
  adminOrderBilling,
  fxTag,
  makeAdminOrderInput,
  makeOrdersAccount,
  makeOrdersCatalog,
  paidOrder,
  placeOrder,
  type OrdersCatalog,
  type TestAccount,
} from "./admin-orders-fixtures";
import { authOf, makeCoupon, makeStaff as makeStaffSession } from "./checkout-fixtures";

const REASON = "Customer asked for two licenses";
let callers: AdminCallers;
let cat: OrdersCatalog;
let account: TestAccount;
let finance: User;
let seq = 0;

beforeAll(async () => {
  callers = await makeAdminCallers();
  cat = await makeOrdersCatalog();
  account = await makeOrdersAccount();
  finance = await makeStaff("FINANCE");
});

const ctx = () => ({ staff: { id: finance.id, role: "FINANCE" as const }, actor: actorFromStaff(finance) });
const patch = (session: TestSession | null, orderId: string, payload: unknown) =>
  callRoute(jar, detailRoute.PATCH, { method: "PATCH", path: `/api/admin/orders/${orderId}`, params: { id: orderId }, session, body: payload });
const cancel = (session: TestSession | null, orderId: string, payload: unknown = { reason: REASON }) =>
  callRoute(jar, cancelRoute.POST, { method: "POST", path: `/api/admin/orders/${orderId}/cancel`, params: { id: orderId }, session, body: payload });
const shareLink = (session: TestSession | null, orderId: string, payload: unknown = { send: false }) =>
  callRoute(jar, linkRoute.POST, { method: "POST", path: `/api/admin/orders/${orderId}/payment-link`, params: { id: orderId }, session, body: payload });

async function linkOrder(over: Record<string, unknown> = {}): Promise<PaymentLinkOrderResult & { token: string }> {
  const created = await createPaymentLinkOrder(orderCreateBody.parse(makeAdminOrderInput(account, cat.plans, over)), ctx());
  return { ...created, token: new URL(created.paymentUrl).searchParams.get("t") ?? "" };
}

const access = (orderId: string, token: string) => resolveOrderAccessFor(orderId, { auth: null, token });
const terms = { acceptTerms: true, version: CHECKOUT_TERMS_VERSION };
const provider = getPaymentProvider("mock");
const attempts = (orderId: string) => db.payment.findMany({ where: { orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const e = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

describe("roles", () => {
  it("PATCH, cancel and payment-link: Owner and Finance only", async () => {
    const order = await linkOrder();
    for (const session of [callers.ADMIN, callers.SUPPORT, callers.customer]) {
      for (const res of [await patch(session, order.orderId, { couponCode: null, reason: REASON }), await cancel(session, order.orderId), await shareLink(session, order.orderId)]) {
        expect(res.status).toBe(403);
        expect(await errorCodeOf(res)).toBe("forbidden");
      }
    }
    expect((await patch(null, order.orderId, { reason: REASON })).status).toBe(401);
    expect((await shareLink(callers.OWNER, order.orderId)).status).toBe(200);
    expect((await shareLink(callers.FINANCE, order.orderId)).status).toBe(200);
  });
});

describe("editing an unpaid order", () => {
  it("re-prices like checkout, replaces the lines and closes the open attempt; the next payment is a fresh provider order", async () => {
    const order = await linkOrder();
    await retryPayment(db, await access(order.orderId, order.token), { provider, terms });
    const [old] = await attempts(order.orderId);
    expect(old).toMatchObject({ status: "CREATED", amountPaise: order.totalPaise });

    const items = [{ planId: cat.plans.annual.id, qty: 1 }, { planId: cat.plans.oneTime.id, qty: 1 }];
    const res = await patch(callers.FINANCE, order.orderId, { items, reason: REASON });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { changed: boolean; order: { totalPaise: number; items: { planId: string }[] } };
    expect(result.changed).toBe(true);

    const fresh = await priceCart(db, { items: orderPatchBody.parse({ items, reason: REASON }).items ?? [], billingState: "Maharashtra" }, { kind: "customer", membership: { accountId: account.accountId, role: "OWNER" } }, new Date());
    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId }, include: { items: { orderBy: { id: "asc" } } } });
    expect([row.totalPaise, row.taxablePaise, row.cgstPaise, row.sgstPaise]).toEqual([fresh.quote.totalPaise, fresh.quote.taxablePaise, fresh.quote.cgstPaise, fresh.quote.sgstPaise]);
    expect(row.items.map((i) => i.planId).sort()).toEqual([cat.plans.annual.id, cat.plans.oneTime.id].sort());
    expect(row.status).toBe("AWAITING_PAYMENT");
    const closed = await db.payment.findUniqueOrThrow({ where: { id: old?.id } });
    expect(closed.status).toBe("CANCELED");
    expect(closed.supersededAt).not.toBeNull();

    const start = await retryPayment(db, await access(order.orderId, order.token), { provider });
    const all = await attempts(order.orderId);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ status: "CREATED", amountPaise: fresh.quote.totalPaise, supersededAt: null });
    expect(all[1]?.providerOrderId).not.toBe(old?.providerOrderId);
    expect(start.orderId).toBe(order.orderId);
    const audit = await db.auditLog.findFirstOrThrow({ where: { targetType: "order", targetId: order.orderId, action: "Updated order" } });
    expect(audit.reason).toBe(REASON);
    expect(audit.detail).toContain("Changed: items");
    expect(audit.detail).toContain("1 payment attempt closed");
  });

  it("sends a late capture of a superseded attempt to REVIEW without licenses", async () => {
    const order = await linkOrder();
    await retryPayment(db, await access(order.orderId, order.token), { provider, terms });
    const [old] = await attempts(order.orderId);
    await updateUnpaidOrder(order.orderId, orderPatchBody.parse({ items: [{ planId: cat.plans.oneTime.id, qty: 1 }], reason: REASON }), ctx());
    const captured = mockCapture(old?.providerOrderId ?? "", old?.amountPaise ?? 0);
    const { result } = await processPaymentEvent("mock", {
      id: `evt_ao_sup_${fxTag}_${++seq}`,
      type: "payment.captured",
      providerOrderId: old?.providerOrderId ?? "",
      providerPaymentId: captured.providerPaymentId,
      amountPaise: old?.amountPaise ?? 0,
      currency: "INR",
    });
    expect(result).toBe("amount_mismatch");
    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect([row.status, row.failReason]).toEqual(["REVIEW", SUPERSEDED_ATTEMPT_REASON]);
    expect(await db.license.count({ where: { orderId: order.orderId } })).toBe(0);
    expect(await db.invoice.count({ where: { orderId: order.orderId } })).toBe(0);
  });

  it("never reopens an open attempt whose amount is no longer the order's total", async () => {
    const order = await linkOrder();
    await retryPayment(db, await access(order.orderId, order.token), { provider, terms });
    const [first] = await attempts(order.orderId);
    // Set up directly: the attempt was made for another amount.
    await db.payment.update({ where: { id: first?.id }, data: { amountPaise: order.totalPaise + 100 } });
    await retryPayment(db, await access(order.orderId, order.token), { provider });
    const all = await attempts(order.orderId);
    expect(all).toHaveLength(2);
    expect(all[1]?.amountPaise).toBe(order.totalPaise);
  });

  it("refuses paid, confirming, in-review and staff-cancelled orders", async () => {
    const paid = await paidOrder({ accountId: account.accountId, items: [{ plan: cat.plans.annual }] });
    let res = await patch(callers.FINANCE, paid.id, { couponCode: null, reason: REASON });
    expect([res.status, await errorCodeOf(res)]).toEqual([409, "not_editable"]);

    const confirming = await placeOrder({ accountId: account.accountId, items: [{ plan: cat.plans.annual }] });
    await db.payment.update({ where: { id: confirming.paymentId }, data: { status: "AUTHORIZED" } });
    res = await patch(callers.FINANCE, confirming.id, { couponCode: null, reason: REASON });
    expect([res.status, await errorCodeOf(res)]).toEqual([409, "payment_in_progress"]);

    const review = await placeOrder({ accountId: account.accountId, items: [{ plan: cat.plans.annual }] });
    await db.order.update({ where: { id: review.id }, data: { status: "REVIEW" } });
    res = await patch(callers.FINANCE, review.id, { couponCode: null, reason: REASON });
    expect([res.status, await errorCodeOf(res)]).toEqual([409, "payment_in_progress"]);

    const cancelled = await linkOrder();
    expect((await cancel(callers.FINANCE, cancelled.orderId)).status).toBe(200);
    res = await patch(callers.FINANCE, cancelled.orderId, { couponCode: null, reason: REASON });
    expect([res.status, await errorCodeOf(res)]).toEqual([409, "order_canceled"]);
    res = await shareLink(callers.FINANCE, cancelled.orderId);
    expect([res.status, await errorCodeOf(res)]).toEqual([409, "not_payable"]);
  });

  it("keeps a limited coupon whose last slot this order holds", async () => {
    const coupon = await makeCoupon({ type: "PERCENT", value: 10, maxRedemptions: 1 });
    const order = await linkOrder({ couponCode: coupon });
    await retryPayment(db, await access(order.orderId, order.token), { provider, terms }); // the attempt holds the slot
    const res = await patch(callers.FINANCE, order.orderId, { items: [{ planId: cat.plans.oneTime.id, qty: 1 }], reason: REASON });
    expect(res.status).toBe(200);
    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.couponCode).toBe(coupon);
    expect(row.discountPaise).toBeGreaterThan(0);
  });

  it("an email change makes the old order link stop working and the new one work", async () => {
    const order = await linkOrder();
    const email = `ao-new-${fxTag}-${++seq}@example.test`;
    const res = await patch(callers.FINANCE, order.orderId, { billing: adminOrderBilling(email), reason: REASON });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { paymentUrl: string; changed: boolean };
    expect(result.changed).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).email).toBe(email);
    const old = await apiError(access(order.orderId, order.token));
    expect(old.status).toBe(404);
    const fresh = await access(order.orderId, new URL(result.paymentUrl).searchParams.get("t") ?? "");
    expect(fresh.viaToken).toBe(true);
  });

  it("a no-op answers changed: false and writes nothing", async () => {
    const order = await linkOrder();
    const before = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    const res = await patch(callers.FINANCE, order.orderId, { items: [{ planId: cat.plans.annual.id, qty: 1 }], couponCode: null, reason: REASON });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { changed: boolean }).changed).toBe(false);
    const after = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(await db.auditLog.count({ where: { targetType: "order", targetId: order.orderId, action: "Updated order" } })).toBe(0);
  });

  it("checks the reason first (422) and refuses an empty patch", async () => {
    const order = await linkOrder();
    let res = await patch(callers.FINANCE, order.orderId, { couponCode: null });
    expect([res.status, await errorCodeOf(res)]).toEqual([422, "reason_required"]);
    res = await patch(callers.FINANCE, order.orderId, { reason: REASON });
    expect([res.status, await errorCodeOf(res)]).toEqual([422, "validation_failed"]);
  });
});

describe("cancelling an unpaid order", () => {
  it("is final for the customer, idempotent, and asks for the reason first", async () => {
    const order = await linkOrder();
    await retryPayment(db, await access(order.orderId, order.token), { provider, terms });
    const res = await cancel(callers.OWNER, order.orderId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "canceled", changed: true });
    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe("CANCELED");
    expect(row.canceledByStaffAt).not.toBeNull();
    const [attempt] = await attempts(order.orderId);
    expect(attempt?.status).toBe("CANCELED");
    expect(attempt?.supersededAt).not.toBeNull();

    const refused = await apiError(retryPayment(db, await access(order.orderId, order.token), { provider, terms }));
    expect([refused.status, refused.code]).toEqual([409, "not_retryable"]);
    const dto = await buildOrderStatus(db, await access(order.orderId, order.token));
    expect(dto).toMatchObject({ canRetry: false, canceledByStaff: true, placedByStaff: true, termsRequired: false });

    const again = await cancel(callers.OWNER, order.orderId);
    expect(await again.json()).toEqual({ status: "canceled", changed: false });
    expect(await db.auditLog.count({ where: { targetType: "order", targetId: order.orderId, action: "Cancelled order" } })).toBe(1);

    const paid = await paidOrder({ accountId: account.accountId, items: [{ plan: cat.plans.annual }] });
    const noReason = await cancel(callers.OWNER, paid.id, {});
    expect([noReason.status, await errorCodeOf(noReason)]).toEqual([422, "reason_required"]);
    const paidCancel = await cancel(callers.OWNER, paid.id);
    expect([paidCancel.status, await errorCodeOf(paidCancel)]).toEqual([409, "not_cancelable"]);
  });
});

describe("re-sharing a payment link", () => {
  it("returns a fresh link, emails it on request and audits without a reason", async () => {
    const order = await linkOrder();
    const res = await shareLink(callers.FINANCE, order.orderId, { send: true });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { url: string; emailQueued: boolean };
    expect(result.emailQueued).toBe(true);
    expect((await access(order.orderId, new URL(result.url).searchParams.get("t") ?? "")).viaToken).toBe(true);
    const audits = await db.auditLog.findMany({ where: { targetType: "order", targetId: order.orderId, action: "Shared payment link" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBeNull();
    expect(await db.outboxEmail.count({ where: { templateId: "order_payment_link", dedupeKey: { startsWith: `order_payment_link:${order.orderId}:` } } })).toBe(1);
  });
});

describe("late payment failures after a staff edit or cancel (review fix)", () => {
  const failed = (providerOrderId: string, amountPaise: number) =>
    processPaymentEvent("mock", {
      id: `evt_ao_fail_${fxTag}_${++seq}`,
      type: "payment.failed",
      providerOrderId,
      providerPaymentId: `pay_ao_fail_${fxTag}_${seq}`,
      amountPaise,
      currency: "INR",
      failureReason: "Card declined",
    });
  const failureMails = (orderId: string) =>
    db.outboxEmail.count({ where: { templateId: "payment_failed", dedupeKey: { startsWith: `payment_failed:${orderId}:` } } });

  it("a staff-cancelled order stays CANCELED and nobody is told to try again", async () => {
    const order = await linkOrder();
    await retryPayment(db, await access(order.orderId, order.token), { provider, terms });
    const [attempt] = await attempts(order.orderId);
    expect((await cancel(callers.FINANCE, order.orderId)).status).toBe(200);
    expect((await failed(attempt?.providerOrderId ?? "", order.totalPaise)).result).toBe("stale_attempt");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("CANCELED");
    expect((await db.payment.findUniqueOrThrow({ where: { id: attempt?.id } })).status).toBe("FAILED");
    expect(await failureMails(order.orderId)).toBe(0);
  });

  it("an edited order stays AWAITING_PAYMENT when the superseded attempt fails", async () => {
    const order = await linkOrder();
    await retryPayment(db, await access(order.orderId, order.token), { provider, terms });
    const [old] = await attempts(order.orderId);
    await updateUnpaidOrder(order.orderId, orderPatchBody.parse({ items: [{ planId: cat.plans.oneTime.id, qty: 1 }], reason: REASON }), ctx());
    expect((await failed(old?.providerOrderId ?? "", old?.amountPaise ?? 0)).result).toBe("stale_attempt");
    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect([row.status, row.failReason]).toEqual(["AWAITING_PAYMENT", null]);
    expect(await failureMails(order.orderId)).toBe(0);
    // The customer can still pay the edited order.
    expect((await buildOrderStatus(db, await access(order.orderId, order.token))).canRetry).toBe(true);
  });
});

describe("staff and the customer's payment (review fix)", () => {
  it("a staff session holding the link cannot accept the terms or start a payment", async () => {
    const order = await linkOrder();
    const staff = await makeStaffSession();
    const staffAccess = await resolveOrderAccessFor(order.orderId, { auth: authOf(staff), token: order.token });
    expect(staffAccess).toMatchObject({ viaToken: true, isPurchaser: false, canAct: false });
    const refused = await apiError(retryPayment(db, staffAccess, { provider, terms }));
    expect([refused.status, refused.code]).toEqual([403, "staff_checkout"]);
    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect([row.termsAcceptedAt, row.termsVersion]).toEqual([null, null]);
    expect(await db.payment.count({ where: { orderId: order.orderId } })).toBe(0);
    expect((await buildOrderStatus(db, staffAccess)).canRetry).toBe(false);
  });

  it("links staff share are pay-only: they pay, and a payment started from one answers with a pay-only token", async () => {
    const order = await linkOrder();
    expect(order.token.startsWith("p1.")).toBe(true);
    const linkAccess = await access(order.orderId, order.token);
    expect(linkAccess).toMatchObject({ viaToken: true, tokenScope: "pay", isPurchaser: false, canAct: true });
    const start = await retryPayment(db, linkAccess, { provider, terms });
    expect(start.orderToken.startsWith("p1.")).toBe(true);
    expect(new URL(start.statusUrl, "http://x.test").searchParams.get("t")).toBe(start.orderToken);
    const res = await shareLink(callers.FINANCE, order.orderId);
    const shared = (await res.json()) as { url: string };
    expect(new URL(shared.url).searchParams.get("t")?.startsWith("p1.")).toBe(true);
  });
});
