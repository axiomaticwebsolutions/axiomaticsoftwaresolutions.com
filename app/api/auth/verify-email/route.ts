/**
 * POST /api/auth/verify-email { code, next? } (session required)
 * -> 200 { verified: true, claimedOrders, redirectTo }. Verifying claims guest orders with the same email and
 * rotates the session (new cookie + CSRF token). 401 "Sign in again to verify your email.", 422 `invalid_code`,
 * 410 `code_expired`, 429 `too_many_attempts` (Retry-After), 403 `csrf_failed`.
 */
import { AUTH_MESSAGES } from "@/lib/auth/flows/common";
import { AUTH_BODY_MAX_BYTES, requestContext, requireAuthWithCsrf, startSessionCookies } from "@/lib/auth/flows/route-helpers";
import { verifyEmailCode } from "@/lib/auth/flows/verify-email";
import { json, parseJsonBody, route } from "@/lib/http";
import { verifyEmailSchema } from "@/lib/validation/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await requireAuthWithCsrf(req, AUTH_MESSAGES.verifySignedOut);
  const input = await parseJsonBody(req, verifyEmailSchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  const result = await verifyEmailCode(auth, input, requestContext(req));
  if (result.session) await startSessionCookies(result.session.token, result.session.session);
  return json({ verified: true, claimedOrders: result.claimedOrders, redirectTo: result.redirectTo });
});
