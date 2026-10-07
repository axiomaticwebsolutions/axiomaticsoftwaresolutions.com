/**
 * POST /api/admin/orders/:id/refund { reason, confirmId, amountPaise?, paymentId? } (refunds.issue: Owner, Finance).
 * Full refund by default: provider refund, then one transaction with the Refund (PENDING) + credit note, license
 * revocation / reversal and exactly one audit row (lib/admin/orders/refund.ts). `paymentId` naming a captured payment
 * that did not pay the order refunds that duplicate alone (no credit note, licenses unchanged, "Refunded duplicate
 * payment"). 201 with the refund; 404 unknown order; 409 already_refunded / not_refundable; 422 reason_required /
 * confirm_mismatch / paymentId; 502 provider_refund_failed.
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { issueOrderRefund } from "@/lib/admin/orders/refund";
import { refundBodySchema } from "@/lib/admin/orders/schemas";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("refunds.issue", async ({ params, staff, actor, body }) => {
  const orderId = idParam(params, "id", "Order");
  const input = await body(refundBodySchema);
  const outcome = await issueOrderRefund({ orderId, staff, actor, body: input });
  return json(
    {
      refund: outcome.refund,
      revokedLicenseIds: outcome.revokedLicenseIds,
      reversedLicenseIds: outcome.reversedLicenseIds,
      review: outcome.review,
      orderStatus: outcome.orderStatus,
      duplicate: outcome.duplicate,
    },
    { status: 201 },
  );
});
