/**
 * Payment event processing (docs/api-contracts.md section 4, docs/decisions.md Phase 1 refinements + Phase 3 Payments).
 * The webhook route, the reconciliation job and admin replays all call processPaymentEvent() with a signature-verified
 * NormalizedEvent; licenses are issued nowhere else for paid orders, except an offline payment Owner or Finance record in
 * Admin > Orders, which runs the same fulfilPaidOrder() (docs/security.md, "Offline payments").
 *
 * One transaction per event:
 * 1. Find the Payment by provider order id (and provider), then `SELECT ... FOR UPDATE` the order row, so every event
 *    for one order runs one at a time.
 * 2. INSERT WebhookEvent(provider, id) with ON CONFLICT DO NOTHING: the primary key is the idempotency guard. A
 *    conflict (sequential or concurrent redelivery, admin replay) answers `duplicate_ignored` and changes nothing.
 * 3. Apply the event:
 *    - payment.captured: already PAID -> `already_paid`; REVIEW -> `order_in_review`; a capture of an attempt a
 *      staff edit replaced (Payment.supersededAt), or an amount, currency or payment amount mismatch -> order REVIEW +
 *      `amount_mismatch` (no licenses); otherwise Payment CAPTURED, then fulfilPaidOrder() (lib/payments/fulfilment.ts:
 *      Order PAID with paidAt = event time, never in the future, licenses, tax invoice with the seller snapshot, coupon
 *      redemption, account activity, member notifications and outbox emails) and the audit row -> `fulfilled`.
 *      Captured after FAILED/CANCELED still pays the order (the money was taken).
 *    - payment.failed: FAILED only for the latest attempt of an unpaid order (+ payment_failed email) ->
 *      `marked_failed`; never downgrades PAID (`already_paid`); older attempts, failures of another payment inside
 *      the same provider order than the one recorded, and attempts settling elsewhere -> `stale_attempt` (onFailed).
 *    - refund.processed: Refund PROCESSED; for a refund of the payment that paid the order, order REFUNDED when its
 *      processed refunds reach the total, else PARTIALLY_REFUNDED; refunds of a duplicate payment leave the order
 *      alone (license revocation is the Phase 6 admin action) -> `refund_processed`. A refund the console did not issue
 *      (provider dashboard) is recorded when it returns a payment that did not pay the order (duplicate capture,
 *      unfulfilled order); one of the paying payment sends the order to REVIEW instead -> `unknown_refund`.
 *    - refund.failed: Refund FAILED (so the order can be refunded again) and the order REVIEW, because a full refund
 *      already revoked or reversed its licenses -> `refund_failed`.
 * 4. Record WebhookEvent.result and a WebhookDelivery row, commit, then kick the email dispatcher.
 * A fulfilment error rolls everything back; a second transaction then records the event as `fulfilment_failed`,
 * marks the payment captured and the order REVIEW with the reason, so the provider gets a 200 and stops retrying.
 * Transient database errors (lib/db-errors.ts) are rethrown instead: the route answers 500 and the event is applied
 * on the provider's redelivery or by reconciliation.
 * Logs carry ids and results only, never payloads, keys or instrument details.
 */
import "server-only";
import {
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  type Payment,
  type Prisma,
  type Refund,
} from "@/generated/prisma/client";
import { SYSTEM_AUDIT_ACTIONS } from "@/lib/admin/audit/model";
import { audit, SYSTEM_ACTOR } from "@/lib/audit";
import { DocumentSeriesExhaustedError } from "@/lib/counters";
import { db, type Db, type Tx } from "@/lib/db";
import { isTransientDatabaseError } from "@/lib/db-errors";
import { enqueueEmail, kickEmailDispatch } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { FulfilmentError } from "@/lib/licensing/fulfil";
import { LicenseTermsError } from "@/lib/licensing/terms";
import { log } from "@/lib/log";
import { formatINR } from "@/lib/money";
import { billingName, fulfilPaidOrder, orderUrl, plural, type PaidOrderRow } from "./fulfilment";
import type { NormalizedEvent } from "./types";

export { sellerSnapshot } from "./fulfilment";

export const WEBHOOK_RESULTS = [
  "fulfilled",
  "duplicate_ignored",
  "already_paid",
  "amount_mismatch",
  "order_in_review",
  "marked_failed",
  "stale_attempt",
  "refund_processed",
  "refund_failed",
  "unknown_refund",
  "unknown_order",
  "fulfilment_failed",
  "invalid_payload",
  "invalid_signature",
  "ignored",
] as const;
export type WebhookResult = (typeof WEBHOOK_RESULTS)[number];

export type ProcessPaymentEventOptions = {
  /** Staff user id when an admin replays a stored event (WebhookDelivery.replayedById). */
  replayedById?: string | null;
  /** Clock for tests. */
  now?: Date;
};
export type ProcessPaymentEventResult = { status: number; result: WebhookResult };

export const DEFAULT_FAILURE_REASON = "Your bank declined the payment.";
/** Refund.failureReason when the provider gives none. */
export const REFUND_FAILED_REASON = "The payment provider couldn\u2019t complete the refund.";
/** Refund.reason / createdById of a refund made outside the console (the provider dashboard). */
export const EXTERNAL_REFUND_REASON = "Refunded at the payment provider (outside the console).";
export const SYSTEM_REFUND_CREATOR = "system";

/** The REVIEW reason after a failed refund (staff decide: refund again, or restore the licenses). */
export function refundFailedReviewReason(refund: string, amount: string, duplicate = false): string {
  return duplicate
    ? `Refund ${refund} (${amount}) of a duplicate payment failed at the payment provider, so the money was not returned. Refund the duplicate payment again, then mark the order reviewed.`
    : `Refund ${refund} (${amount}) failed at the payment provider, so the money was not returned. Licenses the refund revoked or changed stay that way: refund the order again, or restore them, then mark the order reviewed.`;
}

/** The REVIEW reason after a provider-dashboard refund of the payment that paid the order. */
export function externalRefundReviewReason(refund: string, amount: string): string {
  return `Refund ${refund} (${amount}) was made at the payment provider, outside the console: no credit note was issued and the licenses are unchanged. Check the order, then mark it reviewed.`;
}

export const AMOUNT_MISMATCH_REASON = "The amount paid doesn\u2019t match the order total. Our team will review it.";
/** REVIEW reason for a capture of a payment attempt that a staff edit replaced (Payment.supersededAt). */
export const SUPERSEDED_ATTEMPT_REASON = "This payment was made for an earlier version of the order. Our team will review it.";
/**
 * payment_failed emails wait this long, and a payment that succeeds meanwhile (Razorpay's checkout lets the customer
 * retry inside the same window) deletes them. The mock checkout has no in-window retry, so its emails go at once.
 */
export const PAYMENT_FAILED_EMAIL_DELAY_MS = 5 * 60_000;

/** Lock waits for concurrent deliveries of one order queue behind the first transaction. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;
const PAID_STATES: ReadonlySet<OrderStatus> = new Set([OrderStatus.PAID, OrderStatus.REFUNDED, OrderStatus.PARTIALLY_REFUNDED]);
const CAPTURED_STATES: ReadonlySet<PaymentStatus> = new Set([PaymentStatus.CAPTURED, PaymentStatus.REFUNDED]);
/** Orders a refund of their paying payment moves to PARTIALLY_REFUNDED / REFUNDED. */
const REFUNDABLE_ORDER_STATES: ReadonlySet<OrderStatus> = new Set([OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED]);

type OrderRow = PaidOrderRow;
type Ctx = { tx: Tx; provider: string; event: NormalizedEvent; now: Date; order: OrderRow; payment: Payment };
type Outcome = { result: WebhookResult; orderId: string | null; kick: boolean };
type ProcessState = { orderId: string | null; fulfilling: boolean };

/** The stored, replayable form of an event (WebhookEvent.payload). NormalizedEvent never holds instrument data. */
export function eventPayload(event: NormalizedEvent): Prisma.InputJsonObject {
  const out: Record<string, string | number> = {
    id: event.id,
    type: event.type,
    providerOrderId: event.providerOrderId,
    amountPaise: event.amountPaise,
    currency: event.currency,
  };
  if (event.providerPaymentId) out.providerPaymentId = event.providerPaymentId;
  if (event.providerRefundId) out.providerRefundId = event.providerRefundId;
  if (event.method) out.method = event.method;
  if (event.failureReason) out.failureReason = event.failureReason;
  if (event.occurredAt && !Number.isNaN(event.occurredAt.getTime())) out.occurredAt = event.occurredAt.toISOString();
  return out;
}

export type WebhookDeliveryInput = {
  provider: string;
  eventId?: string | null;
  type?: string | null;
  orderId?: string | null;
  signatureOk: boolean;
  result: WebhookResult;
  replayedById?: string | null;
  receivedAt?: Date;
};

function deliveryData(input: WebhookDeliveryInput): Prisma.WebhookDeliveryCreateManyInput {
  return {
    provider: input.provider,
    eventId: input.eventId ?? null,
    type: input.type ?? null,
    orderId: input.orderId ?? null,
    signatureOk: input.signatureOk,
    result: input.result,
    replayedById: input.replayedById ?? null,
    ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
  };
}

/** Records one delivery attempt outside an event transaction (bad signatures, unparseable or ignored bodies). */
export async function recordWebhookDelivery(input: WebhookDeliveryInput, client: Db = db): Promise<void> {
  await client.webhookDelivery.create({ data: deliveryData(input) });
}

/** Order.paidAt / Payment.capturedAt: the provider's event time when it is valid and not in the future, else now. */
export function paidAtFor(event: Pick<NormalizedEvent, "occurredAt">, now: Date): Date {
  const at = event.occurredAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime()) || at.getTime() > now.getTime()) return now;
  return at;
}

/** A short, stable label for why fulfilment failed (REVIEW reason, audit). Never a message that could hold data. */
export function fulfilmentErrorCode(error: unknown): string {
  if (error instanceof FulfilmentError) return error.code;
  if (error instanceof LicenseTermsError) return `terms_${error.code}`;
  if (error instanceof DocumentSeriesExhaustedError) return "invoice_series_exhausted";
  if (error instanceof Error) return error.name || "error";
  return "unknown_error";
}

function failedEmailDelayMs(provider: string): number {
  return provider === "mock" ? 0 : PAYMENT_FAILED_EMAIL_DELAY_MS;
}

function amountLabel(paise: number, currency: string): string {
  return currency === "INR" && Number.isSafeInteger(paise) ? formatINR(paise, { exact: true }) : `${paise} (${currency})`;
}

/** Payment CAPTURED with the provider payment id (unless another row already holds it), method and capture time. */
async function markPaymentCaptured(tx: Tx, payment: Payment, event: NormalizedEvent, capturedAt: Date): Promise<void> {
  const providerPaymentId = event.providerPaymentId ?? null;
  let setId = providerPaymentId !== null;
  if (providerPaymentId !== null && payment.providerPaymentId !== providerPaymentId) {
    const holder = await tx.payment.findUnique({ where: { providerPaymentId }, select: { id: true } });
    if (holder && holder.id !== payment.id) {
      setId = false;
      log.warn("payment_id_held_by_other_payment", { paymentId: payment.id, otherPaymentId: holder.id });
    }
  }
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: PaymentStatus.CAPTURED,
      capturedAt,
      failureReason: null,
      ...(setId && providerPaymentId ? { providerPaymentId } : {}),
      ...(event.method ? { method: event.method } : {}),
    },
  });
}

/** Bookkeeping for a failed attempt; captured or refunded rows are never touched. */
async function markAttemptFailed(ctx: Ctx): Promise<void> {
  const { tx, payment, event } = ctx;
  if (CAPTURED_STATES.has(payment.status) || payment.status === PaymentStatus.FAILED) return;
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: PaymentStatus.FAILED,
      failureReason: event.failureReason ?? DEFAULT_FAILURE_REASON,
      ...(event.method ? { method: event.method } : {}),
    },
  });
}

/** A capture for an order that is already paid: bookkeeping only, and a flag for finance when it is a second payment. */
async function onCapturedAfterPaid(ctx: Ctx): Promise<void> {
  const { tx, order, payment, event, now } = ctx;
  const known = await tx.payment.findFirst({
    where: { orderId: order.id, providerPaymentId: event.providerPaymentId, status: { in: [...CAPTURED_STATES] } },
    select: { id: true },
  });
  if (known) return; // The payment that paid the order: e.g. Razorpay's order.paid after payment.captured.
  if (!CAPTURED_STATES.has(payment.status)) await markPaymentCaptured(tx, payment, event, paidAtFor(event, now));
  log.warn("payment_captured_after_paid", { orderId: order.id, paymentId: payment.id });
  await audit(tx, SYSTEM_ACTOR, {
    action: SYSTEM_AUDIT_ACTIONS.duplicateCapture,
    target: order.id,
    targetType: "order",
    targetId: order.id,
    detail: `Another payment (${event.providerPaymentId ?? "unknown id"}, ${amountLabel(event.amountPaise, event.currency)}) was captured after the order was paid. Refund it.`,
  });
}

async function onCaptured(ctx: Ctx, state: ProcessState): Promise<Outcome> {
  const { tx, order, payment, event, now, provider } = ctx;
  const outcome = (result: WebhookResult, kick = false): Outcome => ({ result, orderId: order.id, kick });
  if (!event.providerPaymentId) return outcome("invalid_payload");
  if (PAID_STATES.has(order.status)) {
    await onCapturedAfterPaid(ctx);
    return outcome("already_paid");
  }
  const capturedAt = paidAtFor(event, now);
  if (order.status === OrderStatus.REVIEW) {
    // A person is already looking at this order; record the money and leave the order alone.
    if (!CAPTURED_STATES.has(payment.status)) await markPaymentCaptured(tx, payment, event, capturedAt);
    log.warn("payment_captured_for_review_order", { orderId: order.id, paymentId: payment.id });
    return outcome("order_in_review");
  }

  await markPaymentCaptured(tx, payment, event, capturedAt);
  if (payment.supersededAt !== null) {
    // A staff edit replaced this attempt (Admin > Orders): its amount or items may no longer be the order's.
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.REVIEW, failReason: SUPERSEDED_ATTEMPT_REASON } });
    await audit(tx, SYSTEM_ACTOR, {
      action: SYSTEM_AUDIT_ACTIONS.orderReview,
      target: order.id,
      targetType: "order",
      targetId: order.id,
      detail: `Payment for an attempt replaced by a staff edit: captured ${amountLabel(event.amountPaise, event.currency)} (${provider} ${event.providerPaymentId}). No licenses issued.`,
    });
    log.warn("payment_superseded_attempt", { orderId: order.id, paymentId: payment.id });
    return outcome("amount_mismatch");
  }
  const mismatch = event.currency !== "INR" || event.amountPaise !== order.totalPaise || event.amountPaise !== payment.amountPaise;
  if (mismatch) {
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.REVIEW, failReason: AMOUNT_MISMATCH_REASON } });
    await audit(tx, SYSTEM_ACTOR, {
      action: SYSTEM_AUDIT_ACTIONS.orderReview,
      target: order.id,
      targetType: "order",
      targetId: order.id,
      detail: `Amount mismatch: captured ${amountLabel(event.amountPaise, event.currency)} for an order total of ${formatINR(order.totalPaise, { exact: true })} (${provider} ${event.providerPaymentId}). No licenses issued.`,
    });
    log.warn("payment_amount_mismatch", { orderId: order.id, paymentId: payment.id });
    return outcome("amount_mismatch");
  }

  // From here on an error is a fulfilment failure: processPaymentEvent() rolls back and marks the order REVIEW.
  state.fulfilling = true;
  const { invoiceNumber, results, issued } = await fulfilPaidOrder(tx, { order, paidAt: capturedAt, now });
  // The prototype's vocabulary: "Webhook processed" · target "payment.captured · AX-10294" · detail "fulfilled …".
  await audit(tx, SYSTEM_ACTOR, {
    action: SYSTEM_AUDIT_ACTIONS.webhookProcessed,
    target: `${event.type} \u00B7 ${order.id}`,
    targetType: "order",
    targetId: order.id,
    detail: `fulfilled \u00B7 Invoice ${invoiceNumber} \u00B7 ${formatINR(order.totalPaise, { exact: true })} via ${provider} (${event.providerPaymentId}) \u00B7 ${plural(issued.length, "license")} issued, ${plural(results.length - issued.length, "license")} updated`,
  });
  return outcome("fulfilled", true);
}

/**
 * payment.failed. One provider order (one Payment row) can hold several payments: Razorpay lets the customer try again
 * inside its checkout, and webhooks arrive in any order. A failure fails the order only when
 * - it concerns the payment this attempt recorded (from a verified return or a capture), or none was recorded yet;
 * - the attempt is the order's latest, and no other attempt holds a verified success (AUTHORIZED) or a capture;
 * - the attempt was not superseded by a staff edit or cancel, and staff did not cancel the order (Admin > Orders);
 * - the order is not PAID/refunded or in REVIEW, and when it is CONFIRMING, the failure is about the very payment whose
 *   return was verified.
 * Otherwise the order is left alone (`stale_attempt`, `already_paid`, `order_in_review`).
 */
async function onFailed(ctx: Ctx): Promise<Outcome> {
  const { tx, order, payment, event, now, provider } = ctx;
  const outcome = (result: WebhookResult, kick = false): Outcome => ({ result, orderId: order.id, kick });
  const recorded = payment.providerPaymentId;
  const samePayment = recorded !== null && event.providerPaymentId !== undefined && recorded === event.providerPaymentId;
  if (recorded !== null && !samePayment) {
    // An earlier payment inside the same provider order failed; the payment recorded on this attempt is unaffected.
    log.info("payment_failed_other_payment", { orderId: order.id, paymentId: payment.id });
    if (PAID_STATES.has(order.status)) return outcome("already_paid");
    if (order.status === OrderStatus.REVIEW) return outcome("order_in_review");
    return outcome("stale_attempt");
  }
  await markAttemptFailed(ctx);
  if (PAID_STATES.has(order.status)) return outcome("already_paid");
  if (order.status === OrderStatus.REVIEW) return outcome("order_in_review");
  // An attempt a staff edit or cancel replaced, or any attempt of an order staff cancelled (Admin > Orders): the failure
  // is recorded on the attempt, but the order keeps its status and nobody is told to "try again".
  if (payment.supersededAt !== null || order.canceledByStaffAt !== null) return outcome("stale_attempt");
  const latest = await tx.payment.findFirst({
    where: { orderId: order.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest?.id !== payment.id || CAPTURED_STATES.has(payment.status)) return outcome("stale_attempt");
  // A verified success (or a capture) on another attempt is still settling: that payment decides the order.
  const settling = await tx.payment.count({
    where: { orderId: order.id, id: { not: payment.id }, status: { in: [PaymentStatus.AUTHORIZED, ...CAPTURED_STATES] } },
  });
  if (settling > 0) return outcome("stale_attempt");
  if (order.status === OrderStatus.CONFIRMING && !samePayment) return outcome("stale_attempt");

  await tx.order.update({
    where: { id: order.id },
    data: { status: OrderStatus.FAILED, failReason: event.failureReason ?? DEFAULT_FAILURE_REASON },
  });
  const delay = failedEmailDelayMs(provider);
  await enqueueEmail(tx, {
    to: order.email,
    templateId: "payment_failed",
    vars: { customer_name: greetingName(billingName(order) ?? order.placedBy?.name), order_id: order.id, order_url: orderUrl(order, now) },
    dedupeKey: `payment_failed:${order.id}:${payment.id}`,
    sendAfter: new Date(now.getTime() + delay),
  });
  return outcome("marked_failed", delay === 0);
}

/**
 * A refund the provider reports that the console did not issue (made in the provider dashboard). It is recorded (as
 * PENDING; the caller marks it PROCESSED) when it returns a captured payment that did not pay the order (a duplicate
 * capture, or an order that was never fulfilled): no credit note and no license change are involved, and the payment
 * then shows REFUNDED so a review can close. A refund of the payment that paid the order is not recorded (it would
 * need a credit note and the licenses revoked): the order goes to REVIEW for staff instead. Null when not recorded.
 */
async function recordExternalRefund(ctx: Ctx): Promise<Refund | null> {
  const { tx, order, payment, event, now, provider } = ctx;
  if (!event.providerRefundId || !CAPTURED_STATES.has(payment.status)) return null;
  const paysOrder = PAID_STATES.has(order.status) && (await payingAttemptId(tx, order)) === payment.id;
  if (!paysOrder) {
    return tx.refund.create({
      data: {
        paymentId: payment.id,
        providerRefundId: event.providerRefundId,
        amountPaise: event.amountPaise,
        reason: EXTERNAL_REFUND_REASON,
        createdById: SYSTEM_REFUND_CREATOR,
        status: RefundStatus.PENDING,
        createdAt: now,
      },
    });
  }
  const amount = amountLabel(event.amountPaise, event.currency);
  if (REFUNDABLE_ORDER_STATES.has(order.status)) {
    await tx.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.REVIEW, failReason: externalRefundReviewReason(event.providerRefundId, amount) },
    });
  }
  await audit(tx, SYSTEM_ACTOR, {
    action: SYSTEM_AUDIT_ACTIONS.orderReview,
    target: order.id,
    targetType: "order",
    targetId: order.id,
    detail: `Refund ${event.providerRefundId} of ${amount} was made at ${provider}, outside the console: no credit note was issued and the licenses are unchanged.`,
  });
  return null;
}

async function onRefund(ctx: Ctx): Promise<Outcome> {
  const { tx, order, payment, event, now } = ctx;
  const outcome = (result: WebhookResult): Outcome => ({ result, orderId: order.id, kick: false });
  const known = event.providerRefundId
    ? await tx.refund.findUnique({ where: { providerRefundId: event.providerRefundId } })
    : null;
  // Refunds are created by the admin refund action before the provider confirms them; see recordExternalRefund().
  let refund = known && known.paymentId === payment.id ? known : null;
  let external = false;
  if (!refund) {
    refund = known ? null : await recordExternalRefund(ctx);
    if (!refund) {
      log.warn("refund_unknown", { orderId: order.id, paymentId: payment.id });
      return outcome("unknown_refund");
    }
    external = true;
  }
  if (refund.amountPaise !== event.amountPaise) {
    log.warn("refund_amount_differs", { orderId: order.id, refundId: refund.id, stored: refund.amountPaise, reported: event.amountPaise });
  }
  if (refund.status !== RefundStatus.PROCESSED) {
    await tx.refund.update({
      where: { id: refund.id },
      data: { status: RefundStatus.PROCESSED, processedAt: paidAtFor(event, now), failureReason: null },
    });
  }
  const processed = await tx.refund.findMany({
    where: { status: RefundStatus.PROCESSED, paymentId: payment.id },
    select: { amountPaise: true },
  });
  const paymentRefunded = processed.reduce((sum, r) => sum + r.amountPaise, 0);
  if (paymentRefunded >= payment.amountPaise && payment.status !== PaymentStatus.REFUNDED) {
    await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.REFUNDED } });
  }
  // Only refunds of the payment that paid the order change the order. Refunding a duplicate payment (the
  // `payment.captured_twice` case) must not mark a paid order refunded, and REVIEW/FAILED orders are staff territory.
  const paysOrder = PAID_STATES.has(order.status) && (await payingAttemptId(tx, order)) === payment.id;
  const paying = paysOrder && REFUNDABLE_ORDER_STATES.has(order.status);
  const next = paying ? (paymentRefunded >= order.totalPaise ? OrderStatus.REFUNDED : OrderStatus.PARTIALLY_REFUNDED) : order.status;
  if (order.status !== next) {
    await tx.order.update({
      where: { id: order.id },
      data: { status: next, ...(next === OrderStatus.REFUNDED ? { refundedAt: now } : {}) },
    });
  }
  if (refund.status !== RefundStatus.PROCESSED) {
    const effect = paying
      ? `order ${next === OrderStatus.REFUNDED ? "refunded" : "partially refunded"}`
      : PAID_STATES.has(order.status) && !paysOrder
        ? "a payment that did not pay the order (duplicate); order status unchanged"
        : `order status unchanged (${order.status})`;
    await audit(tx, SYSTEM_ACTOR, {
      action: SYSTEM_AUDIT_ACTIONS.refundProcessed,
      target: order.id,
      targetType: "order",
      targetId: order.id,
      detail: `Refund ${refund.providerRefundId ?? refund.id} of ${formatINR(refund.amountPaise, { exact: true })}${external ? " made at the payment provider," : ""} processed \u00B7 ${effect}`,
    });
  }
  return outcome("refund_processed");
}

/**
 * refund.failed: the provider could not return the money (a closed bank account, for example). The refund becomes
 * FAILED, which leaves it out of the credit-note reports and of the amount already refunded, so the order can be
 * refunded again. The order goes to REVIEW: a full refund already revoked or reversed the licenses and told the
 * customer the money was on its way, so staff refund again or restore the licenses, then mark the order reviewed.
 */
async function onRefundFailed(ctx: Ctx): Promise<Outcome> {
  const { tx, order, payment, event, provider } = ctx;
  const outcome = (result: WebhookResult): Outcome => ({ result, orderId: order.id, kick: false });
  const refund = event.providerRefundId
    ? await tx.refund.findUnique({ where: { providerRefundId: event.providerRefundId } })
    : null;
  if (!refund || refund.paymentId !== payment.id) {
    log.warn("refund_unknown", { orderId: order.id, paymentId: payment.id });
    return outcome("unknown_refund");
  }
  if (refund.status !== RefundStatus.PENDING) {
    // FAILED already (the same failure under another event id), or PROCESSED: the provider's final word is applied.
    if (refund.status === RefundStatus.PROCESSED) log.warn("refund_failed_after_processed", { orderId: order.id, refundId: refund.id });
    return outcome("refund_failed");
  }
  const reason = (event.failureReason?.trim() || REFUND_FAILED_REASON).slice(0, 300);
  await tx.refund.update({ where: { id: refund.id }, data: { status: RefundStatus.FAILED, failureReason: reason, processedAt: null } });
  const label = refund.providerRefundId ?? refund.id;
  const amount = formatINR(refund.amountPaise, { exact: true });
  const review = REFUNDABLE_ORDER_STATES.has(order.status) || order.status === OrderStatus.REVIEW;
  if (review) {
    // A duplicate payment's refund never touched the licenses (lib/admin/orders/refund.ts).
    const duplicate = refund.creditNoteNo === null && (await payingAttemptId(tx, order)) !== payment.id;
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.REVIEW, failReason: refundFailedReviewReason(label, amount, duplicate) } });
  }
  await audit(tx, SYSTEM_ACTOR, {
    action: SYSTEM_AUDIT_ACTIONS.refundFailed,
    target: order.id,
    targetType: "order",
    targetId: order.id,
    detail: `Refund ${label} of ${amount} failed at ${provider}: ${reason}${review ? " \u00B7 order flagged for review" : ""}`,
  });
  log.warn("refund_failed", { orderId: order.id, refundId: refund.id, review });
  return outcome("refund_failed");
}

/**
 * The attempt whose capture paid the order: the only capture; else the one the order's `fulfilled` event named; else
 * the capture recorded at Order.paidAt; else the earliest capture.
 */
async function payingAttemptId(tx: Tx, order: OrderRow): Promise<string | null> {
  const captured = await tx.payment.findMany({
    where: { orderId: order.id, status: { in: [...CAPTURED_STATES] } },
    orderBy: [{ capturedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, providerOrderId: true, capturedAt: true },
  });
  if (captured.length <= 1) return captured[0]?.id ?? null;
  const fulfilled = await tx.webhookEvent.findFirst({
    where: { orderId: order.id, result: "fulfilled" },
    orderBy: { receivedAt: "asc" },
    select: { payload: true },
  });
  const payload = fulfilled?.payload;
  const named =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).providerOrderId : undefined;
  const byEvent = typeof named === "string" ? captured.find((p) => p.providerOrderId === named) : undefined;
  if (byEvent) return byEvent.id;
  const paidAt = order.paidAt?.getTime();
  return (captured.find((p) => paidAt !== undefined && p.capturedAt?.getTime() === paidAt) ?? captured[0])?.id ?? null;
}

async function lockOrder(tx: Tx, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
}

/** INSERT ... ON CONFLICT DO NOTHING (never aborts the transaction). False when the event was seen before. */
async function claimEvent(tx: Tx, provider: string, event: NormalizedEvent, orderId: string | null, result: WebhookResult | "processing", now: Date): Promise<boolean> {
  const inserted = await tx.webhookEvent.createMany({
    data: [
      {
        provider,
        id: event.id,
        type: event.type,
        orderId,
        result,
        payload: eventPayload(event),
        receivedAt: now,
        ...(result === "processing" ? {} : { processedAt: now }),
      },
    ],
    skipDuplicates: true,
  });
  return inserted.count === 1;
}

async function processInTransaction(
  tx: Tx,
  provider: string,
  event: NormalizedEvent,
  now: Date,
  replayedById: string | null,
  state: ProcessState,
): Promise<Outcome> {
  const found = await tx.payment.findUnique({
    where: { providerOrderId: event.providerOrderId },
    select: { id: true, orderId: true, provider: true },
  });
  const known = found && found.provider === provider ? found : null;
  if (known) await lockOrder(tx, known.orderId);
  const orderId = known?.orderId ?? null;
  const delivery = (result: WebhookResult) =>
    tx.webhookDelivery.create({
      data: deliveryData({ provider, eventId: event.id, type: event.type, orderId, signatureOk: true, result, replayedById, receivedAt: now }),
    });

  if (!(await claimEvent(tx, provider, event, orderId, "processing", now))) {
    await delivery("duplicate_ignored");
    return { result: "duplicate_ignored", orderId, kick: false };
  }

  let outcome: Outcome;
  if (!known) {
    log.warn("payment_event_unknown_order", { provider, eventId: event.id, type: event.type });
    outcome = { result: "unknown_order", orderId: null, kick: false };
  } else {
    state.orderId = known.orderId;
    const order = await tx.order.findUniqueOrThrow({ where: { id: known.orderId }, include: { placedBy: { select: { name: true } } } });
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: known.id } });
    const ctx: Ctx = { tx, provider, event, now, order, payment };
    switch (event.type) {
      case "payment.captured":
        outcome = await onCaptured(ctx, state);
        break;
      case "payment.failed":
        outcome = await onFailed(ctx);
        break;
      case "refund.processed":
        outcome = await onRefund(ctx);
        break;
      case "refund.failed":
        outcome = await onRefundFailed(ctx);
        break;
    }
  }
  await tx.webhookEvent.update({
    where: { provider_id: { provider, id: event.id } },
    data: { result: outcome.result, processedAt: now },
  });
  await delivery(outcome.result);
  return outcome;
}

/** Second transaction after a rolled-back fulfilment: event recorded as fulfilment_failed, order REVIEW. */
async function markFulfilmentFailed(
  tx: Tx,
  provider: string,
  event: NormalizedEvent,
  orderId: string,
  code: string,
  now: Date,
  replayedById: string | null,
): Promise<Outcome> {
  await lockOrder(tx, orderId);
  const claimed = await claimEvent(tx, provider, event, orderId, "fulfilment_failed", now);
  const result: WebhookResult = claimed ? "fulfilment_failed" : "duplicate_ignored";
  if (claimed) {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    const payment = await tx.payment.findUnique({ where: { providerOrderId: event.providerOrderId } });
    if (payment && payment.orderId === orderId && !CAPTURED_STATES.has(payment.status)) {
      await markPaymentCaptured(tx, payment, event, paidAtFor(event, now));
    }
    if (!PAID_STATES.has(order.status)) {
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.REVIEW, failReason: `Payment received; fulfilment needs a manual check (${code}).` },
      });
      await audit(tx, SYSTEM_ACTOR, {
        action: SYSTEM_AUDIT_ACTIONS.orderReview,
        target: orderId,
        targetType: "order",
        targetId: orderId,
        detail: `Fulfilment failed (${code}) for ${provider} event ${event.id}; payment ${event.providerPaymentId ?? "unknown"} captured, no licenses issued.`,
      });
    }
  }
  await tx.webhookDelivery.create({
    data: deliveryData({ provider, eventId: event.id, type: event.type, orderId, signatureOk: true, result, replayedById, receivedAt: now }),
  });
  return { result, orderId, kick: false };
}

/**
 * Applies one signature-verified provider event. Idempotent per (provider, event id); safe to call concurrently.
 * Resolves to `{ status: 200, result }` for every handled outcome (duplicates, unknown orders and fulfilment failures
 * included) and throws only for database trouble (unavailable, timeouts, deadlocks), so the provider retries later.
 */
export async function processPaymentEvent(
  provider: string,
  event: NormalizedEvent,
  opts: ProcessPaymentEventOptions = {},
): Promise<ProcessPaymentEventResult> {
  const now = opts.now ?? new Date();
  const replayedById = opts.replayedById ?? null;
  const state: ProcessState = { orderId: null, fulfilling: false };
  let outcome: Outcome;
  try {
    outcome = await db.$transaction((tx) => processInTransaction(tx, provider, event, now, replayedById, state), TX_OPTIONS);
  } catch (error) {
    const orderId = state.orderId;
    if (!state.fulfilling || orderId === null) throw error;
    if (isTransientDatabaseError(error)) {
      // Infrastructure trouble (lock wait timeout, deadlock, lost connection), not a problem with the order: the
      // rolled-back transaction never claimed the event, so the provider's redelivery or reconciliation fulfils later.
      const dbCode = (error as { code?: unknown }).code;
      log.warn("payment_fulfilment_retry", {
        provider,
        eventId: event.id,
        orderId,
        reason: typeof dbCode === "string" ? dbCode : fulfilmentErrorCode(error),
      });
      throw error;
    }
    const code = fulfilmentErrorCode(error);
    log.error("payment_fulfilment_failed", { provider, eventId: event.id, orderId, reason: code });
    outcome = await db.$transaction((tx) => markFulfilmentFailed(tx, provider, event, orderId, code, now, replayedById), TX_OPTIONS);
  }
  if (outcome.kick) kickEmailDispatch();
  log.info("payment_event_processed", { provider, eventId: event.id, type: event.type, orderId: outcome.orderId, result: outcome.result });
  return { status: 200, result: outcome.result };
}
