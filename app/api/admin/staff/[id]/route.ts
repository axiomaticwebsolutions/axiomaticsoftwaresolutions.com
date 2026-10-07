/**
 * GET /api/admin/staff/:id -> { staff: StaffRow } (404 for anyone who is not staff).
 * PATCH /api/admin/staff/:id { role, reason } -> { staff }: a destructive action (staff.change_role): reason 4-500
 * characters, exactly one "Changed staff role" audit row ("Support → Finance"). 409 `own_role` (not your own role),
 * `role_unchanged`, `last_owner` (at least one active Owner remains), `staff_changed`; 422 reason / role. Owner and
 * Finance get two-step sign-in turned on. Owner only (staff.manage).
 */
import { destructiveFields } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { staffRoleField } from "@/lib/admin/staff/model";
import { changeStaffRole, getStaffMember } from "@/lib/admin/staff/service";
import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const changeRoleSchema = z.strictObject({ ...destructiveFields, role: staffRoleField });

export const GET = adminRoute<{ id: string }>("staff.manage", async ({ params }) => {
  return json({ staff: await getStaffMember(db, idParam(params, "id", "Staff member")) });
});

export const PATCH = adminRoute<{ id: string }>("staff.manage", async ({ params, staff, actor, body }) => {
  const id = idParam(params, "id", "Staff member");
  const input = await body(changeRoleSchema);
  return json({ staff: await changeStaffRole({ staff, actor }, id, input) });
});
