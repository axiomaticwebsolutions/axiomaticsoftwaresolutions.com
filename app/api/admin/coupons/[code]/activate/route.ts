/** POST /api/admin/coupons/:code/activate (coupons.manage) -> { coupon, changed }; audited "Activated coupon". */
import { setCouponActive } from "@/lib/admin/coupons/service";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ code: string }>("coupons.manage", async ({ params, actor }) =>
  json(await setCouponActive(idParam(params, "code", "Coupon"), true, { actor })),
);
