/**
 * GET /api/me/sessions -> 200 { sessions: [{ id, current, device, mobile, userAgent, ipPrefix, createdAt,
 *   lastSeenAt, expiresAt }] } (live sessions of the signed-in user, this device first).
 * DELETE /api/me/sessions -> 200 { revoked } ("Sign out all others"; the current session stays).
 * Customers (Security) and staff with live console access (Admin > My profile); other staff 403.
 */
import { listMySessions, revokeOtherSessions } from "@/lib/auth/flows/me";
import { parseEmptyBody, requireAuthWithCsrf } from "@/lib/auth/flows/route-helpers";
import { assertSelfService, requireUser } from "@/lib/auth/guards";
import { json, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const auth = assertSelfService(await requireUser());
  return json({ sessions: await listMySessions(auth) });
});

export const DELETE = route(async (req) => {
  const auth = assertSelfService(await requireAuthWithCsrf(req));
  await parseEmptyBody(req);
  return json(await revokeOtherSessions(auth));
});
