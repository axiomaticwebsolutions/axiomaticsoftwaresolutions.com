/**
 * POST /api/staff-invites/accept { token, name, password } -> 200 { redirectTo: "/admin", user: { id, name, email } }
 * plus a new staff session cookie (CSRF token re-issued). The link proves the address, so the email counts as
 * verified; two-step sign-in starts off for every role until the person turns it on in Admin > My profile
 * (decisions.md 2026-10-08). 403 `signed_in` when this browser is signed in (customer or staff: sign out first), 403
 * `csrf_failed`; 404 `invite_invalid`, 410 `invite_used` | `invite_revoked` | `invite_expired`, 409 `invite_changed`;
 * 422 on name / password ("Use at least 8 characters with letters and a number."); 429 after 20 attempts in 15
 * minutes per IP.
 */
import { acceptStaffInvite } from "@/lib/admin/staff/invites";
import { STAFF_RATE_LIMITS } from "@/lib/admin/staff/limits";
import { acceptStaffInviteSchema } from "@/lib/admin/staff/model";
import { AUTH_BODY_MAX_BYTES, authWithCsrf, requestContext, startSessionCookies } from "@/lib/auth/flows/route-helpers";
import { enforce, hit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await authWithCsrf(req);
  const input = await parseJsonBody(req, acceptStaffInviteSchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  const context = requestContext(req);
  enforce(await hit(db, STAFF_RATE_LIMITS.acceptIp(context.ip)));
  const result = await acceptStaffInvite(input, {
    current: auth ? { email: auth.user.email } : null,
    ip: context.ip,
    userAgent: context.userAgent,
  });
  await startSessionCookies(result.token, result.session);
  return json({ redirectTo: result.redirectTo, user: { id: result.user.id, name: result.user.name, email: result.user.email } });
});
