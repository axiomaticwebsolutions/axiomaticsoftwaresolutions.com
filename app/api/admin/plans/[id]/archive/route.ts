/**
 * POST /api/admin/plans/:id/archive (pricing.manage) { reason } -> { plan }. Destructive rule plans.archive: reason
 * required, one audit row in the same transaction. Plans are never deleted.
 */
import { setPlanArchived } from "@/lib/admin/catalog/plans";
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("pricing.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Plan");
  const input = await body(destructiveBodySchema);
  return json({ plan: await setPlanArchived(id, true, { staff, actor, input }) });
});
