/**
 * Admin refunds end to end (decisions.md Phase 6 "Refunds", rule 11): POST /api/admin/orders/:id/refund through the
 * real route, the mock provider and the refund.processed webhook. Full refunds revoke NEW licenses, reverse renewals
 * and add-ons exactly, revoke converted trials, flag changed licenses for review; second refunds are refused.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { POST as refundRoute } from "@/app/api/admin/orders/[id]/refund/route";
import { POST as reviewRoute } from "@/app/api/admin/orders/[id]/review/route";
import { db } from "@/lib/db";
import { activePaymentProvider, getPaymentProvider } from "@/lib/payments";
import { mockCapture } from "@/lib/payments/mock";
import { processPaymentEvent } from "@/lib/payments/webhook";
import type { MockProvider } from "@/lib/payments/mock";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import {
  addDevices,
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

beforeAll(async () => {
  callers = await makeAdminCallers();
  catalog = await makeOrdersCatalog();
  account = await makeOrdersAccount();
});

const refund = (orderId: string, session: TestSession | null, body: Record<string, unknown> = { reason: "Customer asked within 7 days", confirmId: orderId }) =>
  callRoute(jar, refundRoute, { method: "POST", path: `/api/admin/orders/${orderId}/refund`, params: { id: orderId }, body, session });

type RefundBody = { refund: { id: string; amountPaise: number; creditNoteNo: string; status: string }; revokedLicenseIds: string[]; reversedLicenseIds: string[]; review: boolean; orderStatus: string };

async function refundOk(order: PaidOrder, session: TestSession = callers.FINANCE): Promise<RefundBody> {
  const res = await refund(order.id, session);
  expect(res.status, (await errorCodeOf(res)) ?? "").toBe(201);
  return (await res.json()) as RefundBody;
}

const refundAudits = (orderId: string) => db.auditLog.findMany({ where: { action: "Issued refund", targetId: orderId } });
const providerRefundId = async (refundId: string) => (await db.refund.findUniqueOrThrow({ where: { id: refundId } })).providerRefundId as string;

describe("full refund of NEW licenses", () => {
  it("revokes the licenses, creates a pending refund with a credit note, notifies, emails and audits once", async () => {
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual }, { plan: catalog.plans.oneTime }] });
    expect(order.licenseIds).toHaveLength(2);

    const body = await refundOk(order);
    expect(body.refund.amountPaise).toBe(order.totalPaise);
    expect(body.refund.creditNoteNo).toMatch(/^AXC\/\d{2}-\d{2}\/\d{4,}$/);
    expect(body.refund.status).toBe("pending");
    expect([...body.revokedLicenseIds].sort()).toEqual([...order.licenseIds].sort());
    expect(body.review).toBe(false);

    const row = await db.refund.findUniqueOrThrow({ where: { id: body.refund.id } });
    expect(row).toMatchObject({ status: "PENDING", amountPaise: order.totalPaise, paymentId: order.paymentId, createdById: callers.FINANCE.user.id });
    expect(row.providerRefundId).toMatch(/^rfnd_mock_/);
    expect(row.reason).toBe("Customer asked within 7 days");
    for (const id of order.licenseIds) {
      const license = await licenseTerms(id);
      expect(license.status).toBe("REVOKED");
      expect(license.revokedReason).toBe(`Order ${order.id} refunded.`);
    }
    const events = await db.licenseEvent.findMany({ where: { licenseId: { in: order.licenseIds }, type: "revoked" } });
    expect(events).toHaveLength(2);

    const audits = await refundAudits(order.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: callers.FINANCE.user.id, actorRole: "finance", targetType: "order", reason: "Customer asked within 7 days" });
    expect(audits[0]?.detail).toContain(body.refund.creditNoteNo);
    expect(audits[0]?.detail).toContain("2 licenses revoked");

    const email = await db.outboxEmail.findUnique({ where: { dedupeKey: `refund_issued:${body.refund.id}` } });
    expect(email?.to).toBe(order.email);
    expect(email?.text).toContain(body.refund.creditNoteNo);
    expect(email?.text).not.toMatch(/[A-Z]{3}(-[A-Z2-9]{4}){4}/);
    const notes = await db.notification.findMany({ where: { userId: account.ownerId, title: `Refund issued for ${order.id}` } });
    expect(notes).toHaveLength(1);

    // The order stays PAID until the provider confirms; refund.processed then marks it REFUNDED.
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    const processed = await processRefund(order, row.providerRefundId as string, order.totalPaise);
    expect(processed.result).toBe("refund_processed");
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("REFUNDED");
    expect(after.refundedAt).not.toBeNull();
    expect((await db.refund.findUniqueOrThrow({ where: { id: body.refund.id } })).status).toBe("PROCESSED");
  });

  it("refuses a second refund (pending and after processing) without calling the provider again", async () => {
    const order = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    const first = await refundOk(order);
    const again = await refund(order.id, callers.OWNER);
    expect(again.status).toBe(409);
    expect(await errorCodeOf(again)).toBe("already_refunded");
    await processRefund(order, await providerRefundId(first.refund.id), order.totalPaise);
    const later = await refund(order.id, callers.FINANCE);
    expect(later.status).toBe(409);
    expect(await errorCodeOf(later)).toBe("already_refunded");
    expect(await db.refund.count({ where: { paymentId: order.paymentId } })).toBe(1);
    expect(await refundAudits(order.id)).toHaveLength(1);
  });

  it("serialises a double click: one refund, one audit row, the other request 409", async () => {
    const order = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    const [a, b] = await Promise.all([refund(order.id, callers.FINANCE), refund(order.id, callers.FINANCE)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await errorCodeOf(a.status === 409 ? a : b)).toBe("already_refunded");
    expect(await db.refund.count({ where: { paymentId: order.paymentId } })).toBe(1);
    expect(await refundAudits(order.id)).toHaveLength(1);
    const mock = getPaymentProvider("mock") as MockProvider;
    expect((await mock.fetchPayment(order.providerPaymentId)).status).toBe("refunded");
  });
});

describe("reversal of renewals, add-ons and upgrades", () => {
  it("restores a renewed license exactly and keeps it active", async () => {
    const license = await issueTestLicense(account.accountId, catalog, catalog.plans.annual, new Date(Date.now() - 300 * 86_400_000));
    const before = await licenseTerms(license.id);
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual, kind: "RENEWAL", target: license.id }] });
    const renewed = await licenseTerms(license.id);
    expect(renewed.expiresAt?.getTime()).toBeGreaterThan(before.expiresAt?.getTime() ?? 0);

    const body = await refundOk(order);
    expect(body.reversedLicenseIds).toEqual([license.id]);
    expect(body.revokedLicenseIds).toEqual([]);
    expect(await licenseTerms(license.id)).toEqual(before);
    const event = await db.licenseEvent.findFirst({ where: { licenseId: license.id, type: "terms_restored" } });
    expect(event?.detail).toBe(`Renewal reversed \u00B7 Order ${order.id} refunded.`);
  });

  it("removes add-on slots exactly and deactivates the devices above the restored limit", async () => {
    const license = await issueTestLicense(account.accountId, catalog, catalog.plans.annual, new Date());
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.addon, kind: "ADDON", quantity: 2, target: license.id }] });
    expect((await licenseTerms(license.id)).deviceLimit).toBe(3);
    const devices = await addDevices(license.id, 3);

    const body = await refundOk(order);
    expect(body.reversedLicenseIds).toEqual([license.id]);
    const after = await licenseTerms(license.id);
    expect(after.deviceLimit).toBe(1);
    expect(after.status).toBe("ACTIVE");
    const active = await db.deviceActivation.findMany({ where: { licenseId: license.id, deactivatedAt: null }, select: { id: true } });
    // The most recently seen computer keeps its slot.
    expect(active.map((d) => d.id)).toEqual([devices[2]]);
  });

  it("reverses a renewal and an add-on of one order in reverse order", async () => {
    const license = await issueTestLicense(account.accountId, catalog, catalog.plans.annual, new Date(Date.now() - 100 * 86_400_000));
    const before = await licenseTerms(license.id);
    const order = await paidOrder({
      accountId: account.accountId,
      items: [
        { plan: catalog.plans.annual, kind: "RENEWAL", target: license.id },
        { plan: catalog.plans.addon, kind: "ADDON", quantity: 1, target: license.id },
      ],
    });
    expect((await licenseTerms(license.id)).deviceLimit).toBe(2);
    const body = await refundOk(order);
    expect(body.review).toBe(false);
    expect(body.reversedLicenseIds).toEqual([license.id, license.id]);
    expect(await licenseTerms(license.id)).toEqual(before);
  });

  it("revokes a trial that the order converted to paid", async () => {
    const trial = await issueTestLicense(account.accountId, catalog, catalog.plans.trial, new Date(), "TRIAL");
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual, kind: "UPGRADE", target: trial.id }] });
    expect((await licenseTerms(trial.id)).status).toBe("ACTIVE");
    const body = await refundOk(order);
    expect(body.revokedLicenseIds).toEqual([trial.id]);
    const after = await licenseTerms(trial.id);
    expect(after.status).toBe("REVOKED");
    expect(after.revokedReason).toBe(`Order ${order.id} refunded.`);
  });

  it("flags the order for review when the license changed since, and Finance closes the review", async () => {
    const license = await issueTestLicense(account.accountId, catalog, catalog.plans.annual, new Date());
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual, kind: "RENEWAL", target: license.id }] });
    await db.license.update({ where: { id: license.id }, data: { status: "SUSPENDED" } });
    const changed = await licenseTerms(license.id);

    const body = await refundOk(order);
    expect(body.review).toBe(true);
    expect(body.orderStatus).toBe("review");
    expect(await licenseTerms(license.id)).toEqual(changed);
    const flagged = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(flagged.status).toBe("REVIEW");
    expect(flagged.failReason).toContain(license.id);
    expect((await refundAudits(order.id))[0]?.detail).toContain("order flagged for review");

    // refund.processed leaves a REVIEW order alone; closing the review needs a reason and Owner / Finance.
    await processRefund(order, await providerRefundId(body.refund.id), order.totalPaise);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REVIEW");
    const review = (session: TestSession | null, reason?: string) =>
      callRoute(jar, reviewRoute, { method: "POST", path: `/api/admin/orders/${order.id}/review`, params: { id: order.id }, body: reason === undefined ? {} : { reason }, session });
    expect((await review(callers.SUPPORT, "Checked")).status).toBe(403);
    expect((await review(callers.ADMIN, "Checked")).status).toBe(403);
    const missing = await review(callers.FINANCE);
    expect(missing.status).toBe(422);
    expect(await errorCodeOf(missing)).toBe("reason_required");
    const ok = await review(callers.FINANCE, "License terms checked by hand");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "refunded" });
    const closed = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed.status).toBe("REFUNDED");
    expect(closed.failReason).toBeNull();
    const audit = await db.auditLog.findFirst({ where: { action: "Resolved review", targetId: order.id } });
    expect(audit).toMatchObject({ reason: "License terms checked by hand", detail: "In review \u2192 Refunded" });
    expect((await review(callers.FINANCE, "Again please")).status).toBe(409);
  });
});

describe("who may refund, and what is checked first", () => {
  it("Support and Admin get 403, customers 403, signed out 401; Owner and Finance may refund", async () => {
    const order = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    for (const session of [callers.SUPPORT, callers.ADMIN, callers.customer]) {
      const res = await refund(order.id, session);
      expect(res.status).toBe(403);
    }
    expect((await refund(order.id, null)).status).toBe(401);
    expect(await db.refund.count({ where: { paymentId: order.paymentId } })).toBe(0);
    expect(await refundAudits(order.id)).toHaveLength(0);
    await refundOk(order, callers.OWNER);
  });

  it("needs a reason and the typed order id before the provider is asked (422)", async () => {
    const order = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    const noReason = await refund(order.id, callers.FINANCE, { confirmId: order.id });
    expect(noReason.status).toBe(422);
    expect(await errorCodeOf(noReason)).toBe("reason_required");
    const short = await refund(order.id, callers.FINANCE, { reason: "no", confirmId: order.id });
    expect(await errorCodeOf(short)).toBe("reason_required");
    const wrongId = await refund(order.id, callers.FINANCE, { reason: "Duplicate purchase", confirmId: "AX-1" });
    expect(wrongId.status).toBe(422);
    expect(await errorCodeOf(wrongId)).toBe("confirm_mismatch");
    const unknown = await refund(order.id, callers.FINANCE, { reason: "Duplicate purchase", confirmId: order.id, extra: 1 });
    expect(unknown.status).toBe(422);
    const mock = getPaymentProvider("mock") as MockProvider;
    expect((await mock.fetchPayment(order.providerPaymentId)).status).toBe("captured");
    expect(await db.refund.count({ where: { paymentId: order.paymentId } })).toBe(0);
    expect((await licenseTerms(order.licenseIds[0] as string)).status).toBe("ACTIVE");
  });

  it("answers 404 for unknown orders and 409 for unpaid ones", async () => {
    expect((await refund("AX-0000001", callers.FINANCE)).status).toBe(404);
    const unpaid = await placeOrder({ items: [{ plan: catalog.plans.annual }] });
    const res = await refund(unpaid.id, callers.FINANCE);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe("not_refundable");
  });
});

describe("partial amounts and provider failures", () => {
  it("accepts an amount: a partial refund changes no license, the remainder completes the refund", async () => {
    const order = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual }] });
    const half = Math.floor(order.totalPaise / 2);
    const first = await refund(order.id, callers.FINANCE, { reason: "Discount promised by sales", confirmId: order.id, amountPaise: half });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as RefundBody;
    expect(firstBody.revokedLicenseIds).toEqual([]);
    expect((await licenseTerms(order.licenseIds[0] as string)).status).toBe("ACTIVE");
    const tooMuch = await refund(order.id, callers.FINANCE, { reason: "Rest of the money", confirmId: order.id, amountPaise: order.totalPaise });
    expect(tooMuch.status).toBe(422);
    const rest = await refundOk(order);
    expect(rest.refund.amountPaise).toBe(order.totalPaise - half);
    expect(rest.revokedLicenseIds).toEqual(order.licenseIds);
    expect(rest.refund.creditNoteNo).not.toBe(firstBody.refund.creditNoteNo);
    await processRefund(order, await providerRefundId(firstBody.refund.id), half);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PARTIALLY_REFUNDED");
    await processRefund(order, await providerRefundId(rest.refund.id), order.totalPaise - half);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
  });

  it("rolls everything back when the provider refuses (502), leaving no refund, credit note or audit row", async () => {
    const order = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    // Refunds go through the ACTIVE provider (the effective configuration: the env mock in these tests).
    const mock = (await activePaymentProvider()) as MockProvider;
    const spy = vi.spyOn(mock, "refund").mockRejectedValueOnce(
      new (await import("@/lib/payments/types")).PaymentProviderError("provider_error", "Gateway timeout", "mock"),
    );
    const res = await refund(order.id, callers.FINANCE);
    spy.mockRestore();
    expect(res.status).toBe(502);
    expect(await errorCodeOf(res)).toBe("provider_refund_failed");
    expect(await db.refund.count({ where: { paymentId: order.paymentId } })).toBe(0);
    expect(await refundAudits(order.id)).toHaveLength(0);
    expect((await licenseTerms(order.licenseIds[0] as string)).status).toBe("ACTIVE");
  });

  it("refunds a mock payment the in-memory ledger no longer holds (dev server restart, seeded orders)", async () => {
    const order = await paidOrder({ items: [{ plan: catalog.plans.annual }] });
    const { resetMockLedger } = await import("@/lib/payments/mock");
    resetMockLedger();
    const body = await refundOk(order);
    expect(body.revokedLicenseIds).toEqual(order.licenseIds);
  });
});

describe("orders in review that were never fulfilled", () => {
  it("refunds the captured payment without a credit note, then Finance closes the review as refunded", async () => {
    const placed = await placeOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.annual, kind: "RENEWAL", target: "LIC-0000000" }] });
    const captured = mockCapture(placed.providerOrderId, placed.totalPaise, "UPI");
    const { result } = await processPaymentEvent("mock", {
      id: `evt_mock_review_${placed.id}`,
      type: "payment.captured",
      providerOrderId: placed.providerOrderId,
      providerPaymentId: captured.providerPaymentId,
      amountPaise: placed.totalPaise,
      currency: "INR",
    });
    expect(result).toBe("fulfilment_failed");
    const order: PaidOrder = { ...placed, providerPaymentId: captured.providerPaymentId, eventId: "", licenseIds: [] };
    const review = (reason: string) =>
      callRoute(jar, reviewRoute, { method: "POST", path: `/api/admin/orders/${order.id}/review`, params: { id: order.id }, body: { reason }, session: callers.FINANCE });

    const early = await review("Looked at the order");
    expect(early.status).toBe(409);
    expect(await errorCodeOf(early)).toBe("refund_first");

    const body = await refundOk(order);
    expect(body.refund.creditNoteNo).toBeNull();
    expect(body.revokedLicenseIds).toEqual([]);
    expect(body.orderStatus).toBe("review");
    expect((await refundAudits(order.id))[0]?.detail).toContain("no credit note (no tax invoice)");
    const pending = await review("Refund still on its way");
    expect(await errorCodeOf(pending)).toBe("refund_pending");

    await processRefund(order, await providerRefundId(body.refund.id), order.totalPaise);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REVIEW");
    const closed = await review("Payment returned, nothing was issued");
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ status: "refunded" });
  });
});
