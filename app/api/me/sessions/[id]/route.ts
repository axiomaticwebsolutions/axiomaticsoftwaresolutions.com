/**
 * DELETE /api/me/sessions/:id -> 200 { revoked: true, current, device }. Only the signed-in user's own live
 * sessions; anything else is 404. Signing out the current session also clears its cookie.
 */
import { AUTH_MESSAGES } from "@/lib/auth/flows/common";
import { revokeMySession } from "@/lib/auth/flows/me";
import { endSessionCookies, parseEmptyBody, requireAuthWithCsrf } from "@/lib/auth/flows/route-helpers";
import { ApiError, json, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (req, ctx) => {
  const auth = await requireAuthWithCsrf(req);
  await parseEmptyBody(req);
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{1,64}$/i.test(id)) throw new ApiError(404, "not_found", AUTH_MESSAGES.sessionNotFound);
  const result = await revokeMySession(auth, id);
  if (result.current) await endSessionCookies();
  return json({ revoked: true, current: result.current, device: result.device });
});
