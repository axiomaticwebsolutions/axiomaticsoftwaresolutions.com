/**
 * POST /api/admin/staff/:id/reactivate { reason } -> { staff }: destructive (staff.reactivate), audited "Reactivated
 * staff". They sign in again with their existing password (two-step on for Owner and Finance). 409
 * `not_deactivated`, `staff_changed`; 422 reason. Owner only.
 */
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { reactivateStaff } from "@/lib/admin/staff/service";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("staff.manage", async ({ params, staff, actor, body }) => {
  const id = idParam(params, "id", "Staff member");
  const input = await body(destructiveBodySchema);
  return json({ staff: await reactivateStaff({ staff, actor }, id, input) });
});
