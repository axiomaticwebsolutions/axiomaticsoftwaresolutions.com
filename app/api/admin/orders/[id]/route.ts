/**
 * GET /api/admin/orders/:id (orders.view): the order drawer (lib/admin/orders/detail.ts).
 *
 * PATCH /api/admin/orders/:id { items?, couponCode?, billing?, reason } (orders.edit: Owner, Finance) -> { order,
 * changed, paymentUrl }: an unpaid order re-priced like checkout; open payment attempts are closed and stamped
 * superseded, so the next payment creates a fresh provider order at the new total. 422 reason_required /
 * validation_failed / cart errors, 404, 409 not_editable / payment_in_progress / order_canceled, 429.
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { getAdminOrderDetail } from "@/lib/admin/orders/detail";
import { updateUnpaidOrder } from "@/lib/admin/orders/edit";
import { orderPatchBody } from "@/lib/admin/orders/schemas";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute<{ id: string }>("orders.view", async ({ params }) =>
  json({ order: await getAdminOrderDetail(db, idParam(params, "id", "Order")) }),
);

export const PATCH = adminRoute<{ id: string }>("orders.edit", async ({ params, staff, actor, body }) => {
  const orderId = idParam(params, "id", "Order");
  const input = await body(orderPatchBody);
  enforce(await hit(db, RATE_LIMITS.adminOrderWrite(staff.id)));
  return json(await updateUnpaidOrder(orderId, input, { staff, actor }));
});
