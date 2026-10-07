/**
 * POST /api/admin/orders/:id/review { reason } (refunds.issue: Owner, Finance): closes a REVIEW and returns the order
 * to the status its payments and refunds show (lib/admin/orders/review.ts). Audited "Resolved review" with the reason.
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { resolveOrderReview } from "@/lib/admin/orders/review";
import { reviewBodySchema } from "@/lib/admin/orders/schemas";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("refunds.issue", async ({ params, staff, actor, body }) => {
  const orderId = idParam(params, "id", "Order");
  const input = await body(reviewBodySchema);
  return json(await resolveOrderReview({ orderId, staff, actor, reason: input.reason }));
});
