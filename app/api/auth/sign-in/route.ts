/**
 * POST /api/auth/sign-in { email, password, next? }
 * -> 200 { requires2fa: false, redirectTo } + session cookie (rotated; CSRF token re-issued)
 * -> 200 { requires2fa: true, challengeId, emailHint } when two-step is on and this device is not trusted
 * -> 401 `invalid_credentials` (identical for unknown email and wrong password), 429 `too_many_attempts`
 *    (5 per email / 20 per IP per 15 minutes, counted before the password check; Retry-After), 422, 403.
 * One endpoint for customers and staff: staff land in /admin, customers in /account (or a safe `next`).
 */
import { AUTH_BODY_MAX_BYTES, authWithCsrf, requestContext, startSessionCookies } from "@/lib/auth/flows/route-helpers";
import { signIn } from "@/lib/auth/flows/sign-in";
import { readTrustedDeviceCookie } from "@/lib/auth/trusted-device";
import { json, parseJsonBody, route } from "@/lib/http";
import { signInSchema } from "@/lib/validation/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await authWithCsrf(req);
  const input = await parseJsonBody(req, signInSchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  const result = await signIn(input, {
    ...requestContext(req),
    currentSessionId: auth?.session.id ?? null,
    trustedDevice: await readTrustedDeviceCookie(),
  });
  if (result.requires2fa) {
    return json({ requires2fa: true, challengeId: result.challengeId, emailHint: result.emailHint });
  }
  await startSessionCookies(result.token, result.session);
  return json({ requires2fa: false, redirectTo: result.redirectTo });
});
