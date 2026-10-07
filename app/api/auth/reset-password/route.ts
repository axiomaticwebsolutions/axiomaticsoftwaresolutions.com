/**
 * POST /api/auth/reset-password { token, password } -> 200 { redirectTo: "/sign-in?reset=1" }.
 *   Single use; revokes every session of the user (the caller's cookie too when it was theirs) and all trusted
 *   devices. 422 `token_invalid` (unknown or used), 410 `token_expired`, 422 `validation_failed`, 429, 403.
 * GET /api/auth/reset-password?token=... -> 200 { email } for the reset page ("For {email}."), or the same
 *   422/410 errors, so the page can show the invalid/expired state before asking for a password.
 */
import { resetInvalidError } from "@/lib/auth/flows/common";
import { AUTH_BODY_MAX_BYTES, authWithCsrf, endSessionCookies, requestContext } from "@/lib/auth/flows/route-helpers";
import { inspectResetToken, resetPassword } from "@/lib/auth/flows/reset-password";
import { json, parseJsonBody, route } from "@/lib/http";
import { resetPasswordSchema, resetTokenSchema } from "@/lib/validation/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const parsed = resetTokenSchema.safeParse(req.nextUrl.searchParams.get("token") ?? "");
  if (!parsed.success) throw resetInvalidError();
  const { email } = await inspectResetToken(parsed.data, requestContext(req));
  return json({ email });
});

export const POST = route(async (req) => {
  const auth = await authWithCsrf(req);
  const input = await parseJsonBody(req, resetPasswordSchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  const result = await resetPassword(input, requestContext(req));
  if (auth && auth.user.id === result.userId) await endSessionCookies();
  return json({ redirectTo: result.redirectTo });
});
