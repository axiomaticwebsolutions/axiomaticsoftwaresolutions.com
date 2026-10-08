/**
 * POST /api/me/password { current, next } -> 200 { revokedSessions }. Signs out every other session (this one
 * stays). 422 `incorrect_password` (fieldErrors.current) or `validation_failed`, 429 (5 checks / 15 min), 401, 403
 * (also for staff without live console access). Customers use it from Security, staff from Admin > My profile.
 */
import { changePassword } from "@/lib/auth/flows/change-password";
import { AUTH_BODY_MAX_BYTES, requireAuthWithCsrf } from "@/lib/auth/flows/route-helpers";
import { assertSelfService } from "@/lib/auth/guards";
import { json, parseJsonBody, route } from "@/lib/http";
import { changePasswordSchema } from "@/lib/validation/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = assertSelfService(await requireAuthWithCsrf(req));
  const input = await parseJsonBody(req, changePasswordSchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  const { revokedSessions } = await changePassword(auth, input);
  return json({ revokedSessions });
});
