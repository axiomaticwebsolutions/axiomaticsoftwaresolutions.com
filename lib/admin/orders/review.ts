/**
 * Closing an order review (POST /api/admin/orders/:id/review; refunds.issue = Owner / Finance). REVIEW orders come
 * from amount mismatches, failed fulfilment, refunds whose license changes could not be reversed, and captures on an
 * order under review. Staff check the order, then mark it reviewed with a reason (saved to the audit log); the order
 * returns to the status its money shows:
 * - it was paid (paidAt set): REFUNDED when processed refunds of the paying payment cover the total, PARTIALLY_REFUNDED
 *   when some do, else PAID;
 * - it was never fulfilled: REFUNDED once every captured payment is refunded, FAILED when nothing was captured;
 *   a captured payment that is still kept must be refunded first (409 `refund_first`, licenses were never issued).
 * A refund still waiting for the provider blocks the review (409 `refund_pending`).
 */
import "server-only";
import { OrderStatus, PaymentStatus, RefundStatus, type StaffRole } from "@/generated/prisma/client";
import { audit, requireReason, type AuditActor } from "@/lib/audit";
import { db as defaultDb } from "@/lib/db";
import { errors } from "@/lib/http";
import { can, roleForbiddenMessage } from "@/lib/rbac";
import { fulfilledProviderOrderId } from "./detail";
import { ORDER_STATUS_FILTER_LABELS, type OrderStatusValue } from "./model";
import { pickPayingPayment } from "./refund-rules";

export const REVIEW_PERMISSION = "refunds.issue" as const;
export const NOT_IN_REVIEW_MESSAGE = "This order isn\u2019t in review.";
export const REFUND_PENDING_MESSAGE = "A refund for this order is still processing. Mark it reviewed once the provider confirms it.";
export const REFUND_FIRST_MESSAGE =
  "A payment was captured but no licenses were issued. Refund the payment before closing the review.";

export type ResolveReviewInput = {
  orderId: string;
  staff: { id: string; role: StaffRole };
  actor: AuditActor;
  reason: unknown;
  now?: Date;
};

export type ResolveReviewResult = { status: OrderStatusValue };

const CAPTURED: ReadonlySet<PaymentStatus> = new Set([PaymentStatus.CAPTURED, PaymentStatus.REFUNDED]);

export async function resolveOrderReview(input: ResolveReviewInput): Promise<ResolveReviewResult> {
  const { orderId, staff, actor } = input;
  const now = input.now ?? new Date();
  if (!can(staff.role, REVIEW_PERMISSION)) throw errors.forbidden(roleForbiddenMessage(staff.role));
  const exists = await defaultDb.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!exists) throw errors.notFound("Order");
  const reason = requireReason(input.reason);

  const next = await defaultDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { payments: { include: { refunds: { select: { amountPaise: true, status: true } } } } },
    });
    if (order.status !== OrderStatus.REVIEW) throw errors.conflict("not_in_review", NOT_IN_REVIEW_MESSAGE);
    const refunds = order.payments.flatMap((p) => p.refunds);
    if (refunds.some((r) => r.status === RefundStatus.PENDING)) throw errors.conflict("refund_pending", REFUND_PENDING_MESSAGE);

    let status: OrderStatus;
    if (order.paidAt) {
      const paying = pickPayingPayment(order.payments, order.paidAt, await fulfilledProviderOrderId(tx, orderId));
      const processed = (paying?.refunds ?? []).filter((r) => r.status === RefundStatus.PROCESSED).reduce((s, r) => s + r.amountPaise, 0);
      status = processed >= order.totalPaise ? OrderStatus.REFUNDED : processed > 0 ? OrderStatus.PARTIALLY_REFUNDED : OrderStatus.PAID;
    } else {
      const captured = order.payments.filter((p) => CAPTURED.has(p.status));
      if (captured.some((p) => p.status !== PaymentStatus.REFUNDED)) throw errors.conflict("refund_first", REFUND_FIRST_MESSAGE);
      status = captured.length > 0 ? OrderStatus.REFUNDED : OrderStatus.FAILED;
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        status,
        failReason: status === OrderStatus.FAILED ? order.failReason : null,
        ...(status === OrderStatus.REFUNDED && !order.refundedAt ? { refundedAt: now } : {}),
      },
    });
    const label = ORDER_STATUS_FILTER_LABELS[status.toLowerCase() as OrderStatusValue];
    await audit(tx, actor, {
      action: "Resolved review",
      target: orderId,
      targetType: "order",
      targetId: orderId,
      reason,
      detail: `In review \u2192 ${label}`,
    });
    return status;
  });
  return { status: next.toLowerCase() as OrderStatusValue };
}
