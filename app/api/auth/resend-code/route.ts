/**
 * POST /api/auth/resend-code (session required; no body or `{}`) -> 200 {}.
 * Emails a new verification code; 3 per 15 minutes (429 with Retry-After). A no-op once the email is verified.
 */
import { AUTH_MESSAGES } from "@/lib/auth/flows/common";
import { resendVerificationCode } from "@/lib/auth/flows/resend-code";
import { parseEmptyBody, requireAuthWithCsrf } from "@/lib/auth/flows/route-helpers";
import { json, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await requireAuthWithCsrf(req, AUTH_MESSAGES.verifySignedOut);
  await parseEmptyBody(req);
  await resendVerificationCode(auth.user);
  return json({});
});
