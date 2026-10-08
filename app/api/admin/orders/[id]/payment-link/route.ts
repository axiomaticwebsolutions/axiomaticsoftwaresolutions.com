/**
 * POST /api/admin/orders/:id/payment-link { send? } (orders.create: Owner, Finance) -> { url, expiresAt, emailQueued }:
 * a freshly signed order link (30 days) for an unpaid order that staff did not cancel; `send: true` also emails it to
 * the order email. Audited ("Shared payment link"), no reason. 404, 409 not_payable, 429.
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { sharePaymentLink } from "@/lib/admin/orders/edit";
import { paymentLinkBody } from "@/lib/admin/orders/schemas";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("orders.create", async ({ params, staff, actor, body }) => {
  const orderId = idParam(params, "id", "Order");
  const input = await body(paymentLinkBody);
  enforce(await hit(db, RATE_LIMITS.adminOrderWrite(staff.id)));
  return json(await sharePaymentLink(db, orderId, input, { staff, actor }));
});
