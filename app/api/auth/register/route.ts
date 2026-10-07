/**
 * POST /api/auth/register { name, email, password, businessName?, next? }
 * -> 201 { user: { id, name, email, emailVerified: false }, redirectTo: "/verify" } + session cookie (and a CSRF
 * token bound to it). Creates User + BusinessAccount (OWNER) and emails a 6-digit code (lib/auth/flows/register.ts).
 * 409 `email_taken`, 422 `validation_failed`, 429 `too_many_attempts` (5 / hour per IP), 403 `csrf_failed`.
 */
import { registerUser } from "@/lib/auth/flows/register";
import { AUTH_BODY_MAX_BYTES, authWithCsrf, requestContext, startSessionCookies } from "@/lib/auth/flows/route-helpers";
import { json, parseJsonBody, route } from "@/lib/http";
import { registerSchema } from "@/lib/validation/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await authWithCsrf(req);
  const input = await parseJsonBody(req, registerSchema, { maxBytes: AUTH_BODY_MAX_BYTES });
  const result = await registerUser(input, { ...requestContext(req), currentSessionId: auth?.session.id ?? null });
  await startSessionCookies(result.token, result.session);
  return json(
    {
      user: { id: result.user.id, name: result.user.name, email: result.user.email, emailVerified: false },
      redirectTo: result.redirectTo,
    },
    { status: 201 },
  );
});
