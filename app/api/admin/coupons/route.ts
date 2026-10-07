/**
 * GET  /api/admin/coupons  (any staff)  ?q=&filter[status]=active|scheduled|paused|expired&sort=(-)code|status|usage|starts
 *                                       &page=&pageSize= -> { items: CouponDto[], total, page, pageSize }
 * POST /api/admin/coupons  (coupons.manage)  { code, type, value, label, minSubtotal?, productIds?, planTypes?, startsOn,
 *                                             endsOn, maxRedemptions? } -> 201 { coupon } (created paused)
 */
import { COUPON_LIST_SPEC } from "@/lib/admin/coupons/model";
import { couponCreateSchema } from "@/lib/admin/coupons/schemas";
import { createCoupon, listCoupons } from "@/lib/admin/coupons/service";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { json } from "@/lib/http";

export const GET = adminRoute(null, async ({ req }) => json(await listCoupons(parseListQuery(req, COUPON_LIST_SPEC))));

export const POST = adminRoute("coupons.manage", async ({ body, actor }) => {
  const input = await body(couponCreateSchema);
  return json({ coupon: await createCoupon(input, { actor }) }, { status: 201 });
});
