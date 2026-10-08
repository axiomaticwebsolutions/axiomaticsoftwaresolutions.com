/**
 * Refunds that do not go to plan (review findings, 2026-10-07):
 * - refund.failed marks the refund FAILED (out of the credit-note reports and of the amount already refunded) and the
 *   order REVIEW; refunding again finds the earlier license reversal in place instead of flagging a mismatch;
 * - a duplicate capture (a second paid attempt, or a capture of an order that was never fulfilled) is refunded on its
 *   own with `paymentId`: no credit note, licenses unchanged, "Refunded duplicate payment";
 * - a refund made in the provider dashboard is recorded for a duplicate payment, and flags the order for review when
 *   it returned the paying payment;
 * - refunds still PENDING after a day are reconciled with the provider (lost refund.processed / refund.failed).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as detailRoute } from "@/app/api/admin/orders/[id]/route";
import { POST as refundRoute } from "@/app/api/admin/orders/[id]/refund/route";
import { POST as reviewRoute } from "@/app/api/admin/orders/[id]/review/route";
import type { AdminOrderDetail } from "@/lib/admin/orders/model";
import { db } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments";
import { mockCapture, mockSetRefundStatus } from "@/lib/payments/mock";
import { reconcilePendingRefunds } from "@/lib/payments/reconcile";
import { processPaymentEvent, REFUND_FAILED_REASON } from "@/lib/payments/webhook";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import {
  fxTag,
  issueTestLicense,
  licenseTerms,
  makeOrdersAccount,
  makeOrdersCatalog,
  paidOrder,
  placeOrder,
  processRefund,
  type OrdersCatalog,
  type PaidOrder,
  type TestAccount,
} from "./admin-orders-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

let callers: AdminCallers;
let catalog: OrdersCatalog;
let account: TestAccount;
let seq = 0;

beforeAll(async () => {
  callers = await makeAdminCallers();
  catalog = await makeOrdersCatalog();
  account = await makeOrdersAccount();
});

type RefundBody = {
  refund: { id: string; amountPaise: number; creditNoteNo: string | null; status: string };
  revokedLicenseIds: string[];
  reversedLicenseIds: string[];
  review: boolean;
  orderStatus: string;
  duplicate: boolean;
};

const refund = (orderId: string, extra: Record<string, unknown> = {}, session: TestSession = callers.FINANCE) =>
  callRoute(jar, refundRoute, {
    method: "POST",
    path: `/api/admin/orders/${orderId}/refund`,
    params: { id: orderId },
    body: { reason: "Customer asked within 7 days", confirmId: orderId, ...extra },
    session,
  });

async function refundOk(orderId: string, extra: Record<string, unknown> = {}): Promise<RefundBody> {
  const res = await refund(orderId, extra);
  expect(res.status, (await errorCodeOf(res)) ?? "").toBe(201);
  return (await res.json()) as RefundBody;
}

const review = (orderId: string, reason: string) =>
  callRoute(jar, reviewRoute, { method: "POST", path: `/api/admin/orders/${orderId}/review`, params: { id: orderId }, body: { reason }, session: callers.FINANCE });

async function detail(orderId: string): Promise<AdminOrderDetail> {
  const res = await callRoute(jar, detailRoute, { path: `/api/admin/orders/${orderId}`, params: { id: orderId }, session: callers.FINANCE });
  expect(res.status).toBe(200);
  return ((await res.json()) as { order: AdminOrderDetail }).order;
}

const providerRefundIdOf = async (refundId: string) => (await db.refund.findUniqueOrThrow({ where: { id: refundId } })).providerRefundId as string;
const orderRow = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const audits = (orderId: string, action: string) => db.auditLog.findMany({ where: { targetId: orderId, action } });

/** The provider fails a refund (the money stays with us) and sends refund.failed, as Razorpay would. */
function failRefund(payment: { providerOrderId: string; providerPaymentId: string }, providerRefundId: string, amountPaise: number, eventId?: string) {
  seq += 1;
  try {
    mockSetRefundStatus(providerRefundId, "failed");
  } catch {
    // A refund id the provider never issued (the unknown-refund case).
  }
  return processPaymentEvent("mock", {
    id: eventId ?? `evt_mock_rff${fxTag}${seq}`,
    type: "refund.failed",
    providerOrderId: payment.providerOrderId,
    providerPaymentId: payment.providerPaymentId,
    providerRefundId,
    amountPaise,
    currency: "INR",
  });
}

/** A second paid attempt of an order: its own Payment row and provider order, captured. */
async function captureAgain(orderId: string, amountPaise: number, expected: string) {
  seq += 1;
  const providerOrderId = `order_mock_dup${fxTag}${seq}`;
  const payment = await db.payment.create({ data: { orderId, provider: "mock", providerOrderId, amountPaise }, select: { id: true } });
  const captured = mockCapture(providerOrderId, amountPaise, "UPI");
  const { result } = await processPaymentEvent("mock", {
    id: `evt_mock_dup${fxTag}${seq}`,
    type: "payment.captured",
    providerOrderId,
    providerPaymentId: captured.providerPaymentId,
    amountPaise,
    currency: "INR",
    method: "UPI",
  });
  expect(result).toBe(expected);
  return { paymentId: payment.id, providerOrderId, providerPaymentId: captured.providerPaymentId };
}

describe("refund.failed", () => {
  it("fails the refund, flags the order for review, and lets Finance refund again without a mismatch", async () => {
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.oneTime }] });
    const first = await refundOk(order.id);
    expect(first.revokedLicenseIds).toEqual(order.licenseIds);
    const firstRefundId = await providerRefundIdOf(first.refund.id);
    // A second refund while the first is pending is refused.
    expect(await errorCodeOf(await refund(order.id))).toBe("already_refunded");

    expect((await failRefund(order, firstRefundId, order.totalPaise)).result).toBe("refund_failed");
    const failed = await db.refund.findUniqueOrThrow({ where: { id: first.refund.id } });
    expect(failed).toMatchObject({ status: "FAILED", failureReason: REFUND_FAILED_REASON, processedAt: null });
    const flagged = await orderRow(order.id);
    expect(flagged.status).toBe("REVIEW");
    expect(flagged.failReason).toContain(`Refund ${firstRefundId}`);
    const [failAudit, ...more] = await audits(order.id, "Refund failed");
    expect(more).toHaveLength(0);
    expect(failAudit).toMatchObject({ actorRole: "system", actorId: null, targetType: "order" });
    expect(failAudit?.detail).toContain("order flagged for review");

    // The same failure under another event id changes nothing.
    expect((await failRefund(order, firstRefundId, order.totalPaise)).result).toBe("refund_failed");
    expect(await audits(order.id, "Refund failed")).toHaveLength(1);

    // FAILED no longer counts as refunded: the drawer offers the refund again and the review cannot close yet.
    expect((await detail(order.id)).refund).toMatchObject({ allowed: true, amountPaise: order.totalPaise });
    const second = await refundOk(order.id);
    expect(second.review).toBe(false);
    expect(second.revokedLicenseIds).toEqual([]);
    expect(second.refund.creditNoteNo).not.toBe(first.refund.creditNoteNo);
    expect(second.orderStatus).toBe("review");
    for (const id of order.licenseIds) expect((await licenseTerms(id)).status).toBe("REVOKED");

    await processRefund(order, await providerRefundIdOf(second.refund.id), order.totalPaise);
    const closed = await review(order.id, "Second refund went through");
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ status: "refunded" });
  });

  it("finds a renewal already reversed by the failed refund (no review for the license)", async () => {
    const license = await issueTestLicense(account.accountId, catalog, catalog.plans.annual, new Date(Date.now() - 300 * 86_400_000));
    const before = await licenseTerms(license.id);
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual, kind: "RENEWAL", target: license.id }] });
    const first = await refundOk(order.id);
    expect(first.reversedLicenseIds).toEqual([license.id]);
    await failRefund(order, await providerRefundIdOf(first.refund.id), order.totalPaise);

    const second = await refundOk(order.id);
    expect(second).toMatchObject({ review: false, reversedLicenseIds: [], revokedLicenseIds: [] });
    expect(await licenseTerms(license.id)).toEqual(before);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).failReason).toContain("failed at the payment provider");
  });

  it("finds a converted trial already revoked by the failed refund", async () => {
    const trial = await issueTestLicense(account.accountId, catalog, catalog.plans.trial, new Date(), "TRIAL");
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual, kind: "UPGRADE", target: trial.id }] });
    const first = await refundOk(order.id);
    expect(first.revokedLicenseIds).toEqual([trial.id]);
    await failRefund(order, await providerRefundIdOf(first.refund.id), order.totalPaise);
    const second = await refundOk(order.id);
    expect(second).toMatchObject({ review: false, revokedLicenseIds: [] });
  });

  it("ignores refund ids it does not know", async () => {
    const order = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    expect((await failRefund(order, `rfnd_mock_unknown${fxTag}`, 100)).result).toBe("unknown_refund");
    expect((await orderRow(order.id)).status).toBe("PAID");
  });
});

describe("duplicate payments (paymentId)", () => {
  it("refunds a second capture of a paid order alone: no credit note, licenses kept, order still paid", async () => {
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.oneTime }] });
    const dup = await captureAgain(order.id, order.totalPaise, "already_paid");
    expect(await audits(order.id, "Duplicate payment captured")).toHaveLength(1);

    const view = await detail(order.id);
    const rows = new Map(view.payments.map((p) => [p.id, p]));
    expect(rows.get(order.paymentId)).toMatchObject({ duplicate: false, refundablePaise: 0 });
    expect(rows.get(dup.paymentId)).toMatchObject({ duplicate: true, refundablePaise: order.totalPaise, status: "captured" });

    const body = await refundOk(order.id, { paymentId: dup.paymentId });
    expect(body).toMatchObject({ duplicate: true, review: false, revokedLicenseIds: [], reversedLicenseIds: [], orderStatus: "paid" });
    expect(body.refund.creditNoteNo).toBeNull();
    expect((await db.refund.findUniqueOrThrow({ where: { id: body.refund.id } })).paymentId).toBe(dup.paymentId);
    for (const id of order.licenseIds) expect((await licenseTerms(id)).status).toBe("ACTIVE");
    const [audit, ...others] = await audits(order.id, "Refunded duplicate payment");
    expect(others).toHaveLength(0);
    expect(audit?.detail).toContain(`duplicate payment ${dup.providerPaymentId}`);
    expect(await audits(order.id, "Issued refund")).toHaveLength(0);

    // The provider confirms: the duplicate shows refunded, the order stays paid.
    const processed = await processPaymentEvent("mock", {
      id: `evt_mock_duprf${fxTag}${(seq += 1)}`,
      type: "refund.processed",
      providerOrderId: dup.providerOrderId,
      providerPaymentId: dup.providerPaymentId,
      providerRefundId: await providerRefundIdOf(body.refund.id),
      amountPaise: order.totalPaise,
      currency: "INR",
    });
    expect(processed.result).toBe("refund_processed");
    expect((await db.payment.findUniqueOrThrow({ where: { id: dup.paymentId } })).status).toBe("REFUNDED");
    expect((await orderRow(order.id)).status).toBe("PAID");
    expect(await errorCodeOf(await refund(order.id, { paymentId: dup.paymentId }))).toBe("already_refunded");

    // The paying payment is still refundable the usual way.
    const full = await refundOk(order.id);
    expect(full).toMatchObject({ duplicate: false, revokedLicenseIds: order.licenseIds });
    expect(full.refund.creditNoteNo).not.toBeNull();
  });

  it("a failed refund of a duplicate flags the order with a duplicate-specific reason; the licenses were never touched", async () => {
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual }] });
    const dup = await captureAgain(order.id, order.totalPaise, "already_paid");
    const body = await refundOk(order.id, { paymentId: dup.paymentId });
    expect((await failRefund(dup, await providerRefundIdOf(body.refund.id), order.totalPaise)).result).toBe("refund_failed");
    const flagged = await orderRow(order.id);
    expect(flagged.status).toBe("REVIEW");
    expect(flagged.failReason).toContain("of a duplicate payment failed");
    for (const id of order.licenseIds) expect((await licenseTerms(id)).status).toBe("ACTIVE");
    // Refundable again (FAILED does not count).
    expect((await detail(order.id)).payments.find((p) => p.id === dup.paymentId)?.refundablePaise).toBe(order.totalPaise);
  });

  it("refuses a payment of another order, and a payment that was never captured", async () => {
    const order = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    const other = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    const res = await refund(order.id, { paymentId: other.paymentId });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { fieldErrors?: Record<string, string[]> } }).error.fieldErrors).toHaveProperty("paymentId");
    const open = await db.payment.create({ data: { orderId: order.id, provider: "mock", providerOrderId: `order_mock_open${fxTag}${(seq += 1)}`, amountPaise: order.totalPaise } });
    expect(await errorCodeOf(await refund(order.id, { paymentId: open.id }))).toBe("not_refundable");
    expect(await db.refund.count({ where: { payment: { orderId: order.id } } })).toBe(0);
  });

  it("closes a never-fulfilled order with two captures once both are refunded", async () => {
    const placed = await placeOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual, kind: "RENEWAL", target: "LIC-0000000" }] });
    const captured = mockCapture(placed.providerOrderId, placed.totalPaise, "UPI");
    const first = await processPaymentEvent("mock", {
      id: `evt_mock_unf${fxTag}${(seq += 1)}`,
      type: "payment.captured",
      providerOrderId: placed.providerOrderId,
      providerPaymentId: captured.providerPaymentId,
      amountPaise: placed.totalPaise,
      currency: "INR",
    });
    expect(first.result).toBe("fulfilment_failed");
    const dup = await captureAgain(placed.id, placed.totalPaise, "order_in_review");
    const order: PaidOrder = { ...placed, providerPaymentId: captured.providerPaymentId, eventId: "", licenseIds: [] };

    const paying = await refundOk(order.id);
    expect(paying).toMatchObject({ duplicate: false, orderStatus: "review" });
    await processRefund(order, await providerRefundIdOf(paying.refund.id), order.totalPaise);
    expect(await errorCodeOf(await review(order.id, "Both payments checked"))).toBe("refund_first");
    expect(await errorCodeOf(await refund(order.id))).toBe("already_refunded");

    const second = await refundOk(order.id, { paymentId: dup.paymentId });
    expect(second).toMatchObject({ duplicate: true, orderStatus: "review" });
    await processPaymentEvent("mock", {
      id: `evt_mock_unf${fxTag}${(seq += 1)}`,
      type: "refund.processed",
      providerOrderId: dup.providerOrderId,
      providerPaymentId: dup.providerPaymentId,
      providerRefundId: await providerRefundIdOf(second.refund.id),
      amountPaise: order.totalPaise,
      currency: "INR",
    });
    const closed = await review(order.id, "Both payments returned");
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ status: "refunded" });
  });
});

describe("payments taken with other keys (Admin > Settings > Integrations changed them)", () => {
  it("refuses with 409 provider_key_changed and changes nothing, but refunds a payment from before key ids were recorded", async () => {
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual }] });
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id, status: "CAPTURED" } });
    await db.payment.update({ where: { id: payment.id }, data: { providerKeyId: "rzp_live_OtherAccount01" } });
    const res = await refund(order.id);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe("provider_key_changed");
    expect(await db.refund.count({ where: { paymentId: payment.id } })).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect((await licenseTerms(order.licenseIds[0] as string)).status).toBe("ACTIVE");
    await db.payment.update({ where: { id: payment.id }, data: { providerKeyId: null } });
    expect((await refundOk(order.id)).refund.status).toBe("pending");
  });
});

describe("refunds made in the provider dashboard", () => {
  it("records one of a duplicate payment (processed, no credit note) and leaves the order alone", async () => {
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual }] });
    const dup = await captureAgain(order.id, order.totalPaise, "already_paid");
    const providerRefundId = `rfnd_mock_dash${fxTag}${(seq += 1)}`;
    const { result } = await processPaymentEvent("mock", {
      id: `evt_mock_dash${fxTag}${seq}`,
      type: "refund.processed",
      providerOrderId: dup.providerOrderId,
      providerPaymentId: dup.providerPaymentId,
      providerRefundId,
      amountPaise: order.totalPaise,
      currency: "INR",
    });
    expect(result).toBe("refund_processed");
    const recorded = await db.refund.findUniqueOrThrow({ where: { providerRefundId } });
    expect(recorded).toMatchObject({ paymentId: dup.paymentId, status: "PROCESSED", creditNoteNo: null, amountPaise: order.totalPaise, createdById: "system" });
    expect((await db.payment.findUniqueOrThrow({ where: { id: dup.paymentId } })).status).toBe("REFUNDED");
    expect((await orderRow(order.id)).status).toBe("PAID");
    const [audit] = await audits(order.id, "Refund processed");
    expect(audit?.detail).toContain("made at the payment provider");
    for (const id of order.licenseIds) expect((await licenseTerms(id)).status).toBe("ACTIVE");
  });

  it("flags the order for review when it returned the payment that paid the order", async () => {
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual }] });
    const providerRefundId = `rfnd_mock_dash${fxTag}${(seq += 1)}`;
    const { result } = await processPaymentEvent("mock", {
      id: `evt_mock_dash${fxTag}${seq}`,
      type: "refund.processed",
      providerOrderId: order.providerOrderId,
      providerPaymentId: order.providerPaymentId,
      providerRefundId,
      amountPaise: order.totalPaise,
      currency: "INR",
    });
    expect(result).toBe("unknown_refund");
    expect(await db.refund.count({ where: { providerRefundId } })).toBe(0);
    const flagged = await orderRow(order.id);
    expect(flagged.status).toBe("REVIEW");
    expect(flagged.failReason).toContain("outside the console");
    expect((await audits(order.id, "Flagged order for review"))[0]?.detail).toContain(providerRefundId);
  });
});

describe("reconcilePendingRefunds", () => {
  it("applies the provider's final state to refunds still pending after a day", async () => {
    const provider = getPaymentProvider("mock");
    const processedOrder = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    const failedOrder = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    const pendingOrder = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    const issued = [await refundOk(processedOrder.id), await refundOk(failedOrder.id), await refundOk(pendingOrder.id)];
    const [processedId, failedId, pendingId] = await Promise.all(issued.map((b) => providerRefundIdOf(b.refund.id)));
    mockSetRefundStatus(failedId as string, "failed");
    mockSetRefundStatus(pendingId as string, "pending");
    // Issued long ago (a window no other test file uses), so this run sees only these three.
    const issuedAt = new Date("2031-03-01T00:00:00.000Z");
    await db.refund.updateMany({ where: { id: { in: issued.map((b) => b.refund.id) } }, data: { createdAt: issuedAt } });

    // Too young: nothing is asked.
    expect((await reconcilePendingRefunds({ provider, now: new Date(issuedAt.getTime() + 3_600_000) })).checked).toBe(0);

    const now = new Date(issuedAt.getTime() + 86_400_000 + 60_000);
    const summary = await reconcilePendingRefunds({ provider, now });
    expect(summary).toMatchObject({ provider: "mock", checked: 3, errors: 0, results: { refund_processed: 1, refund_failed: 1 } });
    const statuses = await db.refund.findMany({ where: { id: { in: issued.map((b) => b.refund.id) } }, select: { providerRefundId: true, status: true } });
    expect(new Map(statuses.map((s) => [s.providerRefundId, s.status]))).toEqual(
      new Map([
        [processedId, "PROCESSED"],
        [failedId, "FAILED"],
        [pendingId, "PENDING"],
      ]),
    );
    expect((await orderRow(processedOrder.id)).status).toBe("REFUNDED");
    expect((await orderRow(failedOrder.id)).status).toBe("REVIEW");
    expect((await orderRow(pendingOrder.id)).status).toBe("PAID");
    // A second run in the same window applies nothing twice.
    const again = await reconcilePendingRefunds({ provider, now });
    expect(again.results).toEqual({});
  });
});
