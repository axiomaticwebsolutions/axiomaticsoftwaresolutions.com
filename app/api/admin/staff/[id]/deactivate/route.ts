/**
 * POST /api/admin/staff/:id/deactivate { reason } -> { staff }: destructive (staff.deactivate). Signs them out of every
 * session and voids their open sign-in, reset and verification codes in the same transaction as the "Deactivated
 * staff" audit row. 409 `deactivate_self`, `not_active`, `last_owner`, `staff_changed`; 422 reason. Owner only.
 */
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { deactivateStaff } from "@/lib/admin/staff/service";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("staff.manage", async ({ params, staff, actor, body }) => {
  const id = idParam(params, "id", "Staff member");
  const input = await body(destructiveBodySchema);
  return json({ staff: await deactivateStaff({ staff, actor }, id, input) });
});
