/**
 * POST /api/admin/staff/:id/resend-invite {} -> { staff, emailSent }: a fresh 7-day link (older links stop working),
 * the email again (sent after the commit, never stored) and a "Resent staff invitation" audit row. 409 `not_invited` once accepted; 429 after 3 per hour per person.
 * Owner only.
 */
import { z } from "zod";
import { adminRoute, idParam } from "@/lib/admin/http";
import { STAFF_RATE_LIMITS } from "@/lib/admin/staff/limits";
import { getStaffMember, resendStaffInvite } from "@/lib/admin/staff/service";
import { enforce, hit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const emptyBody = z.strictObject({});

export const POST = adminRoute<{ id: string }>("staff.manage", async ({ params, staff, actor, body }) => {
  const id = idParam(params, "id", "Staff member");
  await body(emptyBody);
  // 404 before the limit, so unknown ids never consume it.
  await getStaffMember(db, id);
  enforce(await hit(db, STAFF_RATE_LIMITS.resend(id)));
  const outcome = await resendStaffInvite({ staff, actor }, id);
  return json({ staff: outcome.staff, emailSent: outcome.emailSent });
});
