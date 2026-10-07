/**
 * POST /api/invites/accept { token, name?, password? } -> 200 { redirectTo: "/account", accountId, user: { id, name,
 * email } } + a rotated session cookie (CSRF token re-issued) with the joined account active.
 * Someone who already has an account must be signed in with the invited email and sends only the token (401
 * `sign_in_required` when signed out, 403 `wrong_account` when signed in as someone else). A new person sends their
 * name and a password (422 on `name` / `password`; "Use at least 8 characters with letters and a number."). The link
 * proves the address, so the email counts as verified. 404 `invite_invalid`, 410 `invite_used` | `invite_revoked` |
 * `invite_expired`, 403 `staff_account`, 403 `csrf_failed`; 429 after 20 attempts in 15 minutes per IP.
 */
import { AUTH_BODY_MAX_BYTES, authWithCsrf, requestContext, startSessionCookies } from "@/lib/auth/flows/route-helpers";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { acceptInvite } from "@/lib/portal/invites";
import { acceptInviteSchema } from "@/lib/validation/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await authWithCsrf(req);
  const input = await parseJsonBody(req, acceptInviteSchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  const context = requestContext(req);
  enforce(await hit(db, RATE_LIMITS.inviteAcceptIp(context.ip)));
  const result = await acceptInvite(input, {
    current: auth ? { userId: auth.user.id, sessionId: auth.session.id } : null,
    ip: context.ip,
    userAgent: context.userAgent,
  });
  await startSessionCookies(result.token, result.session);
  return json({
    redirectTo: result.redirectTo,
    accountId: result.accountId,
    user: { id: result.user.id, name: result.user.name, email: result.user.email },
  });
});
