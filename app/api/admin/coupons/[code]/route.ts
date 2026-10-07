/**
 * GET    /api/admin/coupons/:code  (any staff)       -> { coupon, orders (newest 5), orderCount }
 * PATCH  /api/admin/coupons/:code  (coupons.manage)  { type?, value?, label?, minSubtotal?, productIds?, planTypes?,
 *                                                       startsOn?, endsOn?, maxRedemptions? } -> { coupon, changed }
 * DELETE /api/admin/coupons/:code  (coupons.manage)  { reason, confirmId: code } -> { code }
 *                                                     (409 coupon_used once any order used it)
 */
import { couponUpdateSchema } from "@/lib/admin/coupons/schemas";
import { deleteCoupon, getCouponDetail, updateCoupon } from "@/lib/admin/coupons/service";
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

type Params = { code: string };

export const GET = adminRoute<Params>(null, async ({ params }) => json(await getCouponDetail(idParam(params, "code", "Coupon"))));

export const PATCH = adminRoute<Params>("coupons.manage", async ({ params, body, actor }) => {
  const code = idParam(params, "code", "Coupon");
  const patch = await body(couponUpdateSchema);
  return json(await updateCoupon(code, patch, { actor }));
});

export const DELETE = adminRoute<Params>("coupons.manage", async ({ params, body, staff, actor }) => {
  const code = idParam(params, "code", "Coupon");
  const input = await body(destructiveBodySchema);
  return json(await deleteCoupon(code, input, { staff, actor }));
});
