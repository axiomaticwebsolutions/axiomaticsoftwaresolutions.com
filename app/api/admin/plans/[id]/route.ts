/**
 * GET /api/admin/plans/:id (any staff) -> { plan: AdminPlanDetail }
 * PATCH /api/admin/plans/:id (pricing.manage) { name?, summary?, includes?, pricePaise?, interval?, trialDays?,
 *   deviceLimit?, perUnit?, maxQty?, multiDevice?, updatesMonths?, popular?, sortOrder? } -> { plan, changed }.
 *   Applies to new purchases and future renewals; audited "Changed plan price" (₹old → ₹new) or "Updated plan".
 */
import { getPlanDetail, updatePlan } from "@/lib/admin/catalog/plans";
import { planUpdateSchema } from "@/lib/admin/catalog/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { errors, json } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = adminRoute<Params>(null, async ({ params }) => {
  const plan = await getPlanDetail(idParam(params, "id", "Plan"));
  if (!plan) throw errors.notFound("Plan");
  return json({ plan });
});

export const PATCH = adminRoute<Params>("pricing.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "Plan");
  const patch = await body(planUpdateSchema);
  return json(await updatePlan(id, patch, { actor }));
});
