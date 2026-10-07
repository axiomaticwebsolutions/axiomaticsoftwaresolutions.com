/**
 * POST /api/auth/forgot-password { email } -> 200 {} always (no account discovery), 422 for a malformed address,
 * 429 only for the per-IP limit (10 / hour). Emails a 30-minute single-use reset link when the account exists.
 */
import { requestPasswordReset } from "@/lib/auth/flows/forgot-password";
import { AUTH_BODY_MAX_BYTES, authWithCsrf, requestContext } from "@/lib/auth/flows/route-helpers";
import { json, parseJsonBody, route } from "@/lib/http";
import { forgotPasswordSchema } from "@/lib/validation/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  await authWithCsrf(req);
  const input = await parseJsonBody(req, forgotPasswordSchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  await requestPasswordReset(input, requestContext(req));
  return json({});
});
