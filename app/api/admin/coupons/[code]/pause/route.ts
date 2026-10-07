/** POST /api/admin/coupons/:code/pause (coupons.manage) -> { coupon, changed }; audited "Paused coupon". */
import { setCouponActive } from "@/lib/admin/coupons/service";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ code: string }>("coupons.manage", async ({ params, actor }) =>
  json(await setCouponActive(idParam(params, "code", "Coupon"), false, { actor })),
);
