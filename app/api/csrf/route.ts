/**
 * GET /api/csrf: issues the double-submit CSRF token (lib/auth/csrf.ts) for the current visitor.
 * Bound to the session id when signed in, otherwise "anon". When the session cannot be resolved (for example no
 * database with CATALOG_SOURCE=fixtures) it falls back to "anon"; signed-in mutations then fail the CSRF check and
 * the client fetches a new token, so nothing is weakened. Sets the readable `axs_csrf` cookie (SameSite=Lax, Secure
 * in production, path /) and returns { token }. Never cached.
 */
import { setCsrfCookie } from "@/lib/auth/cookies";
import { ANON_CSRF_BINDING, csrfBinding, issueCsrfToken } from "@/lib/auth/csrf";
import { getCurrentAuth } from "@/lib/auth/guards";
import { getEnv } from "@/lib/env";
import { json, route } from "@/lib/http";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

async function currentBinding(): Promise<string> {
  try {
    const auth = await getCurrentAuth();
    return csrfBinding(auth?.session.id);
  } catch (error) {
    log.warn("csrf_session_unavailable", { error });
    return ANON_CSRF_BINDING;
  }
}

export const GET = route(async () => {
  const token = issueCsrfToken(await currentBinding(), getEnv().CSRF_SECRET);
  await setCsrfCookie(token);
  return json({ token }, { headers: { "cache-control": "no-store" } });
});
