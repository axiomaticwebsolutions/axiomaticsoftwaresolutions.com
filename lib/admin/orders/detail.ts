/**
 * One order for the admin drawer (GET /api/admin/orders/:id): facts, billing snapshot, totals with the GST split,
 * items with their licenses, payment attempts, refunds with credit notes, webhook deliveries (replayable when the
 * signature-valid event is stored), licenses issued (masked keys only), the audit history and the refund state, plus
 * the admin-records state (who created the order, offline payment details, billing corrections, and whether it can be
 * edited, cancelled, shared as a payment link or corrected).
 */
import "server-only";
import { ItemKind, LicenseStatus } from "@/generated/prisma/client";
import { auditActionLabel } from "@/lib/admin/audit/model";
import type { Db } from "@/lib/db";
import { errors } from "@/lib/http";
import { maskLicenseKey } from "@/lib/licensing/keys";
import { deriveLicenseStatus } from "@/lib/licensing/status";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { OFFLINE_PROVIDER } from "@/lib/payments/types";
import { customerName, productLabel, statusValue } from "./list";
import type { AdminOrderDetail, AdminOrderHistoryEntry, AdminOrderWebhook } from "./model";
import { ORDER_RECORD_MESSAGES, orderCorrectionState, orderEditState, paymentLinkAllowed } from "./records-model";
import { isRefundableStatus, pickPayingPayment, refundableAmount, reversalOrder } from "./refund-rules";

const HISTORY_LIMIT = 50;
const CAPTURED_STATUSES = new Set(["CAPTURED", "REFUNDED"]);
const WEBHOOK_LIMIT = 50;

/** Payload `providerOrderId` of the order's `fulfilled` event (which attempt paid, for orders with two captures). */
export async function fulfilledProviderOrderId(db: Db, orderId: string): Promise<string | null> {
  const event = await db.webhookEvent.findFirst({
    where: { orderId, result: "fulfilled" },
    orderBy: { receivedAt: "asc" },
    select: { payload: true },
  });
  const payload = event?.payload;
  const value = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).providerOrderId : null;
  return typeof value === "string" ? value : null;
}

async function namesOf(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

export async function getAdminOrderDetail(db: Db, id: string, now: Date = new Date()): Promise<AdminOrderDetail> {
  const order = await db.order.findUnique({
    where: { id },
    include: {
      account: { select: { legalName: true } },
      invoice: { select: { number: true, issuedAt: true } },
      items: { include: { plan: { select: { name: true, productId: true, product: { select: { name: true, shortName: true } } } } }, orderBy: { id: "asc" } },
      invoiceCorrections: { orderBy: [{ issuedAt: "asc" }, { id: "asc" }] },
      payments: { include: { refunds: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!order) throw errors.notFound("Order");

  const [licenses, deliveries, events, fulfilledOrderId] = await Promise.all([
    db.license.findMany({
      where: { orderId: id },
      select: { id: true, keyLast4: true, status: true, expiresAt: true, product: { select: { name: true, shortName: true, code: true } } },
      orderBy: { id: "asc" },
    }),
    db.webhookDelivery.findMany({ where: { orderId: id }, orderBy: [{ receivedAt: "asc" }, { id: "asc" }], take: WEBHOOK_LIMIT }),
    db.webhookEvent.findMany({ where: { orderId: id }, select: { provider: true, id: true, type: true, result: true, receivedAt: true }, take: WEBHOOK_LIMIT }),
    fulfilledProviderOrderId(db, id),
  ]);
  const eventIds = [...new Set(events.map((e) => e.id))];
  const audits = await db.auditLog.findMany({
    where: {
      OR: [
        { targetType: "order", targetId: id },
        ...(eventIds.length > 0 ? [{ targetType: "webhook", targetId: { in: eventIds } }] : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_LIMIT,
    select: { id: true, action: true, actorId: true, actorRole: true, reason: true, detail: true, createdAt: true },
  });
  const refunds = order.payments.flatMap((p) => p.refunds);
  const names = await namesOf(db, [
    ...refunds.map((r) => r.createdById),
    ...deliveries.map((d) => d.replayedById),
    ...audits.map((a) => a.actorId),
    order.createdByStaffId,
    ...order.payments.map((p) => p.recordedById),
    ...order.invoiceCorrections.map((c) => c.createdById),
  ]);

  const stored = new Set(events.map((e) => `${e.provider}\u0000${e.id}`));
  const webhooks: AdminOrderWebhook[] = deliveries.map((d) => ({
    id: d.id,
    provider: d.provider,
    eventId: d.eventId,
    type: d.type,
    result: d.result,
    receivedAt: d.receivedAt.toISOString(),
    signatureOk: d.signatureOk,
    replayedBy: d.replayedById ? (names.get(d.replayedById) ?? "Staff") : null,
    replayable: d.eventId !== null && stored.has(`${d.provider}\u0000${d.eventId}`),
  }));
  // Events stored without a delivery row (older data) still show, and can be replayed.
  const delivered = new Set(deliveries.map((d) => `${d.provider}\u0000${d.eventId ?? ""}`));
  for (const e of events) {
    if (delivered.has(`${e.provider}\u0000${e.id}`)) continue;
    webhooks.push({
      id: `event:${e.provider}:${e.id}`,
      provider: e.provider,
      eventId: e.id,
      type: e.type,
      result: e.result,
      receivedAt: e.receivedAt.toISOString(),
      signatureOk: true,
      replayedBy: null,
      replayable: true,
    });
  }
  webhooks.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));

  const paying = pickPayingPayment(order.payments, order.paidAt, fulfilledOrderId);
  const amountPaise = paying ? refundableAmount(paying, paying.refunds) : 0;
  const issuedIds = new Set(order.items.filter((i) => i.kind === ItemKind.NEW && i.issuedLicenseId).map((i) => i.issuedLicenseId));
  const licenseCount = licenses.filter((l) => issuedIds.has(l.id) && l.status !== LicenseStatus.REVOKED).length;
  const allowed = isRefundableStatus(order.status) && paying !== null && paying.providerPaymentId !== null && amountPaise > 0;
  // Offline payments have no provider payment to refund (docs/decisions.md "Admin records" D20).
  const unavailableReason = paying?.provider === OFFLINE_PROVIDER && isRefundableStatus(order.status) ? ORDER_RECORD_MESSAGES.offlineRefund : null;

  const billing = readBillingSnapshot(order.billing);
  const history: AdminOrderHistoryEntry[] = audits.map((a) => ({
    id: a.id,
    action: auditActionLabel(a.action),
    actor: a.actorId ? (names.get(a.actorId) ?? "Staff") : "System",
    reason: a.reason,
    detail: a.detail,
    at: a.createdAt.toISOString(),
  }));

  return {
    id: order.id,
    status: statusValue(order.status),
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    refundedAt: order.refundedAt?.toISOString() ?? null,
    email: order.email,
    failReason: order.failReason,
    customer: customerName(order.billing, order.account?.legalName, order.email),
    accountId: order.accountId,
    billing: {
      name: billing.name,
      business: billing.business,
      address: billing.address,
      city: billing.city,
      state: billing.state,
      pin: billing.pin,
      phone: billing.phone,
    },
    gstin: billing.gstin,
    placeOfSupply: order.placeOfSupply,
    couponCode: order.couponCode,
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    taxablePaise: order.taxablePaise,
    cgstPaise: order.cgstPaise,
    sgstPaise: order.sgstPaise,
    igstPaise: order.igstPaise,
    totalPaise: order.totalPaise,
    invoice: order.invoice ? { number: order.invoice.number, issuedAt: order.invoice.issuedAt.toISOString() } : null,
    items: order.items.map((i) => ({
      id: i.id,
      planId: i.planId,
      productId: i.plan.productId,
      product: productLabel(i.plan.product),
      plan: i.plan.name,
      kind: i.kind,
      quantity: i.quantity,
      linePaise: i.unitPricePaise * i.quantity,
      issuedLicenseId: i.issuedLicenseId,
      targetLicenseId: i.targetLicenseId,
      fulfilled: i.fulfilledAt !== null,
    })),
    payments: order.payments.map((p) => {
      // Captures other than the paying one are refunded on their own (lib/admin/orders/refund.ts, paymentId).
      const duplicate = CAPTURED_STATUSES.has(p.status) && p.providerPaymentId !== null && p.id !== paying?.id;
      return {
        id: p.id,
        provider: p.provider,
        providerOrderId: p.providerOrderId,
        providerPaymentId: p.providerPaymentId,
        method: p.method,
        status: p.status.toLowerCase(),
        amountPaise: p.amountPaise,
        createdAt: p.createdAt.toISOString(),
        capturedAt: p.capturedAt?.toISOString() ?? null,
        failureReason: p.failureReason,
        duplicate,
        refundablePaise: duplicate ? refundableAmount(p, p.refunds) : 0,
        offline: p.provider === OFFLINE_PROVIDER,
        reference: p.reference,
        receivedAt: p.receivedAt?.toISOString() ?? null,
        recordedBy: p.recordedById ? (names.get(p.recordedById) ?? "Staff") : null,
      };
    }),
    refunds: refunds.map((r) => ({
      id: r.id,
      amountPaise: r.amountPaise,
      reason: r.reason,
      creditNoteNo: r.creditNoteNo,
      status: r.status.toLowerCase(),
      createdAt: r.createdAt.toISOString(),
      processedAt: r.processedAt?.toISOString() ?? null,
      createdBy: names.get(r.createdById) ?? null,
      providerRefundId: r.providerRefundId,
    })),
    webhooks,
    licenses: licenses.map((l) => ({
      id: l.id,
      product: productLabel(l.product),
      maskedKey: maskLicenseKey(l.product.code, l.keyLast4),
      status: deriveLicenseStatus(l, now),
    })),
    history,
    refund: { allowed, amountPaise, licenseCount, changeCount: reversalOrder(order.items).length, unavailableReason },
    createdBy: order.createdByStaffId ? { id: order.createdByStaffId, name: names.get(order.createdByStaffId) ?? "Staff" } : null,
    canceledByStaffAt: order.canceledByStaffAt?.toISOString() ?? null,
    termsAcceptedAt: order.termsAcceptedAt?.toISOString() ?? null,
    billingEmail: billing.email || order.email,
    corrections: order.invoiceCorrections.map((c) => ({
      id: c.id,
      creditNoteNo: c.creditNoteNo,
      originalInvoiceNo: c.originalInvoiceNo,
      originalIssuedAt: c.originalIssuedAt.toISOString(),
      newInvoiceNo: c.newInvoiceNo,
      issuedAt: c.issuedAt.toISOString(),
      changedFields: [...c.changedFields],
      by: names.get(c.createdById) ?? "Staff",
    })),
    edit: orderEditState(order),
    paymentLink: { allowed: paymentLinkAllowed(order) },
    correction: orderCorrectionState({ status: order.status, hasInvoice: order.invoice !== null, refunds }),
  };
}
