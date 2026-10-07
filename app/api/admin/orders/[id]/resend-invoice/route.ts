/**
 * POST /api/admin/orders/:id/resend-invoice (orders.resend_invoice: every staff role): queues the order confirmation
 * email with the invoice again (new dedupe key) and audits "Resent invoice". 404 unknown order, 409 invoice_unavailable
 * before payment, 409 already_queued while the previous resend is still in the outbox.
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { resendInvoices, ALREADY_QUEUED_REASON, NOT_FOUND_REASON } from "@/lib/admin/orders/resend";
import { emptyBodySchema } from "@/lib/admin/orders/schemas";
import { errors, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_INVOICE_MESSAGE = "This order has no invoice yet. Invoices are issued once the payment is confirmed.";
const QUEUED_MESSAGE = "An invoice email for this order is already on its way.";

export const POST = adminRoute<{ id: string }>("orders.resend_invoice", async ({ req, params, actor, body }) => {
  const orderId = idParam(params, "id", "Order");
  if (req.headers.get("content-type")) await body(emptyBodySchema);
  const result = await resendInvoices({ ids: [orderId], actor });
  const skipped = result.skipped[0];
  if (skipped) {
    if (skipped.reason === NOT_FOUND_REASON) throw errors.notFound("Order");
    if (skipped.reason === ALREADY_QUEUED_REASON) throw errors.conflict("already_queued", QUEUED_MESSAGE);
    throw errors.conflict("invoice_unavailable", NO_INVOICE_MESSAGE);
  }
  return json(result, { status: 202 });
});
