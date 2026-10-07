/**
 * DELETE /api/admin/staff/:id/invite { reason } -> { revoked: { id, email } }: revokes a pending invitation. The invited
 * person never signed in, so their pending staff record is removed (every link stops working; the address can be
 * invited again). DESTRUCTIVE_ACTIONS "staff.revoke_invite": 422 reason_required, one audit row "Revoked staff
 * invitation". 409 `not_invited` once accepted. Owner only.
 */
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { revokeStaffInvite } from "@/lib/admin/staff/service";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = adminRoute<{ id: string }>("staff.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Staff member");
  return json({ revoked: await revokeStaffInvite({ staff, actor }, id, await body(destructiveBodySchema)) });
});
