/**
 * POST /api/auth/sign-in/verify { challengeId, code, trustDevice } (two-step sign-in, emailed code)
 * -> 200 { redirectTo } + session cookie (+ `axs_td` trusted-device cookie for 30 days when trustDevice)
 * -> 422 `invalid_code`, 410 `code_expired` (sign in again), 429 `too_many_attempts` (Retry-After), 403.
 */
import { verifyLoginCode } from "@/lib/auth/flows/login-code";
import { AUTH_BODY_MAX_BYTES, authWithCsrf, requestContext, startSessionCookies } from "@/lib/auth/flows/route-helpers";
import { setTrustedDeviceCookie } from "@/lib/auth/trusted-device";
import { json, parseJsonBody, route } from "@/lib/http";
import { signInVerifySchema } from "@/lib/validation/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await authWithCsrf(req);
  const input = await parseJsonBody(req, signInVerifySchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  const result = await verifyLoginCode(input, { ...requestContext(req), currentSessionId: auth?.session.id ?? null });
  await startSessionCookies(result.token, result.session);
  if (result.trustedDevice) await setTrustedDeviceCookie(result.trustedDevice.value, result.trustedDevice.expiresAt);
  return json({ redirectTo: result.redirectTo });
});
