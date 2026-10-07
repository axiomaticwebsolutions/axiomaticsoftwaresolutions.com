/**
 * Plumbing shared by the auth and /api/me route handlers (Next.js request context only):
 * request context (trusted client IP, user agent), session + CSRF check in one step, and the cookie changes that
 * go with starting or ending a session. The CSRF token is bound to the session id (lib/auth/csrf.ts), so every
 * session change re-issues it; client code (lib/client/api.ts) reads the new cookie on its next mutation.
 */
import "server-only";
import type { NextRequest } from "next/server";
import type { Session } from "@/generated/prisma/client";
import type { AuthRequestContext } from "@/lib/auth/flows/common";
import { clearSessionCookie, setCsrfCookie, setSessionCookie } from "@/lib/auth/cookies";
import { ANON_CSRF_BINDING, assertCsrf, csrfBinding, issueCsrfToken } from "@/lib/auth/csrf";
import { getCurrentAuth, type CurrentAuth } from "@/lib/auth/guards";
import { getEnv } from "@/lib/env";
import { ApiError, clientIp, errors, parseJsonBody } from "@/lib/http";
import { emptyBodySchema } from "@/lib/validation/auth";

/** Auth request bodies are tiny; anything larger is refused before parsing. */
export const AUTH_BODY_MAX_BYTES = 8 * 1024;

const MAX_USER_AGENT = 512;

export function requestContext(req: NextRequest): AuthRequestContext {
  const ua = req.headers.get("user-agent");
  return { ip: clientIp(req), userAgent: ua ? ua.slice(0, MAX_USER_AGENT) : null };
}

/**
 * Resolves the current session (or null) and verifies the CSRF token against its binding ("anon" when signed
 * out). For every mutating auth route; 403 `csrf_failed` on failure.
 */
export async function authWithCsrf(req: NextRequest): Promise<CurrentAuth | null> {
  const env = getEnv();
  const auth = await getCurrentAuth();
  assertCsrf(req, { binding: csrfBinding(auth?.session.id), secret: env.CSRF_SECRET, appUrl: env.APP_URL });
  return auth;
}

/** Like authWithCsrf, but a session is required: 401 (with `message`) when signed out. */
export async function requireAuthWithCsrf(req: NextRequest, message?: string): Promise<CurrentAuth> {
  const auth = await getCurrentAuth();
  if (!auth) throw message ? new ApiError(401, "unauthorized", message) : errors.unauthorized();
  const env = getEnv();
  assertCsrf(req, { binding: csrfBinding(auth.session.id), secret: env.CSRF_SECRET, appUrl: env.APP_URL });
  return auth;
}

/** Sets the session cookie and a CSRF token bound to the new session. */
export async function startSessionCookies(token: string, session: Pick<Session, "id" | "expiresAt">): Promise<void> {
  await setSessionCookie(token, session.expiresAt);
  await setCsrfCookie(issueCsrfToken(csrfBinding(session.id), getEnv().CSRF_SECRET));
}

/** Clears the session cookie and issues an anonymous CSRF token (signed-out forms keep working). */
export async function endSessionCookies(): Promise<void> {
  await clearSessionCookie();
  await setCsrfCookie(issueCsrfToken(ANON_CSRF_BINDING, getEnv().CSRF_SECRET));
}

/** Endpoints without input accept no body or an empty JSON object; anything else is refused (strict). */
export async function parseEmptyBody(req: NextRequest): Promise<void> {
  if (req.body === null || req.headers.get("content-length") === "0") return;
  if (!req.headers.get("content-type")) {
    // Browsers send a body-less DELETE without Content-Length (Fetch adds "0" only for POST and PUT), and Next.js
    // still hands the handler an empty body stream: an untyped body without bytes is no body.
    if ((await readUpTo(req.body, 1024)) === 0) return;
    throw errors.unsupportedMediaType();
  }
  await parseJsonBody(req, emptyBodySchema, { maxBytes: 1024 });
}

/** Number of bytes in the stream, reading at most `limit` + 1 of them. */
async function readUpTo(body: ReadableStream<Uint8Array>, limit: number): Promise<number> {
  const reader = body.getReader();
  let total = 0;
  try {
    while (total <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return total;
}
