/**
 * GET /api/admin/plans?q=&filter[product]=&filter[type]=trial|one_time|annual|subscription|device_addon|maintenance
 *   &filter[status]=on_sale|archived&sort=product|name|price&page=&pageSize= (any staff)
 *   -> { items: AdminPlanRow[], total, page, pageSize } (default: grouped by product)
 * POST /api/admin/plans (pricing.manage) { id, productId, type, name, pricePaise, ...terms } -> 201 { plan }
 */
import { planListQuery } from "@/lib/admin/catalog/api";
import { createPlan, listPlans } from "@/lib/admin/catalog/plans";
import { planCreateSchema } from "@/lib/admin/catalog/schemas";
import { adminRoute } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = adminRoute(null, async ({ req }) => json(await listPlans(planListQuery(req))));

export const POST = adminRoute("pricing.manage", async ({ body, actor }) => {
  const input = await body(planCreateSchema);
  return json({ plan: await createPlan(input, { actor }) }, { status: 201 });
});
