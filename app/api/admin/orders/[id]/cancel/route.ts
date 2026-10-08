/**
 * POST /api/admin/orders/:id/cancel { reason } (orders.edit: Owner, Finance; DESTRUCTIVE "orders.cancel") ->
 * { status: "canceled", changed }: an unpaid order cancelled by staff can't be paid again (the customer's retry refuses
 * it). Idempotent (already cancelled by staff: `changed: false`, no new audit row). 422 reason (checked first), 404,
 * 409 not_cancelable / payment_in_progress, 429.
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { cancelUnpaidOrder } from "@/lib/admin/orders/edit";
import { orderCancelBody } from "@/lib/admin/orders/schemas";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("orders.edit", async ({ params, staff, actor, body }) => {
  const orderId = idParam(params, "id", "Order");
  const input = await body(orderCancelBody);
  enforce(await hit(db, RATE_LIMITS.adminOrderWrite(staff.id)));
  return json(await cancelUnpaidOrder(orderId, { staff, actor, input }));
});
