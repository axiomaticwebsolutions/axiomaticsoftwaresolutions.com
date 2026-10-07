/**
 * GET /api/admin/staff?q=&filter[role]=owner|admin|support|finance&filter[status]=active|invited|deactivated
 *   &sort=name|role|status|lastActive (prefix "-" for descending)&page=&pageSize= -> { items: StaffRow[], total, page,
 *   pageSize }.
 * POST /api/admin/staff { email, role } -> 201 { staff: StaffRow, emailSent }: a STAFF user (INVITED, no password), a
 *   7-day STAFF_INVITE link and the "Invited staff" audit row; the email is sent after the commit and never stored
 *   (emailSent false: it could not be sent, resend it). 409 `customer_email` (staff and
 *   customers are separate users), `already_staff`, `already_invited`, `staff_deactivated`; 422 on email/role; 429 after
 *   20 invitations per hour. Owner only (staff.manage).
 */
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { STAFF_RATE_LIMITS } from "@/lib/admin/staff/limits";
import { inviteStaffSchema, STAFF_LIST_SPEC } from "@/lib/admin/staff/model";
import { inviteStaff, listStaff } from "@/lib/admin/staff/service";
import { enforce, hit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("staff.manage", async ({ req }) => {
  return json(await listStaff(db, parseListQuery(req, STAFF_LIST_SPEC)));
});

export const POST = adminRoute("staff.manage", async ({ staff, actor, body }) => {
  const input = await body(inviteStaffSchema);
  enforce(await hit(db, STAFF_RATE_LIMITS.invite(staff.id)));
  const outcome = await inviteStaff({ staff, actor }, input);
  return json({ staff: outcome.staff, emailSent: outcome.emailSent }, { status: 201 });
});
