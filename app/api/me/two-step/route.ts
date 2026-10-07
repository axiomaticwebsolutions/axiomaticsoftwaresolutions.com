/**
 * POST /api/me/two-step { enabled, password? } -> 200 { twoStepEnabled, changed }: turns emailed sign-in codes on or
 * off for the signed-in user. On: needs a verified email (403 email_unverified) and sends nothing now (codes come at
 * sign-in). Off: needs the account password (422 incorrect_password with fieldErrors.password; 5 checks / 15 min per
 * user, 429 after). A change logs "Turned on|off two-step verification" (security) on the active business account.
 * CSRF + same origin; 20 changes / hour per user. 401 signed out, 422 validation_failed.
 */
import { AUTH_BODY_MAX_BYTES, requireAuthWithCsrf } from "@/lib/auth/flows/route-helpers";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { setTwoStep } from "@/lib/portal/profile";
import { twoStepSchema } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await requireAuthWithCsrf(req);
  const input = await parseJsonBody(req, twoStepSchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  return json(await setTwoStep(auth, input, { client: db }));
});
