/**
 * CSRF protection for cookie-authenticated mutations: a double-submit token bound to the session.
 *
 * The token "<nonce>.<HMAC(CSRF_SECRET, nonce + ':' + binding)>" is set in the readable cookie `axs_csrf`;
 * client code echoes it in the `x-csrf-token` header. A request passes when header === cookie (constant time)
 * AND the signature is valid for the current binding (session id, or "anon" for signed-out flows such as
 * sign-in and checkout). A token minted for one session is useless in another, and an attacker who can plant
 * a cookie still cannot forge the signature. sameOriginOk() adds an Origin/Referer check as defence in depth.
 *
 * Exempt (no cookies, authenticated by other means): `/api/webhooks/*` (provider signatures) and
 * `/api/v1/licenses/*` (the device API, authenticated by license key / activation token).
 *
 * After sign-in, sign-out or session rotation the binding changes: issue a new token with the new session id.
 */
import { errors } from "@/lib/http";
import { CSRF_COOKIE, CSRF_HEADER } from "@/lib/auth/csrf-names";
import { hmacSha256, randomToken, safeEqual } from "@/lib/auth/tokens";

export { CSRF_COOKIE, CSRF_HEADER };
export const ANON_CSRF_BINDING = "anon";

const MAX_TOKEN_LENGTH = 256;
const CSRF_EXEMPT_PREFIXES = ["/api/webhooks/", "/api/v1/licenses/"] as const;

/** The binding for a request: the session id when signed in, otherwise "anon". */
export function csrfBinding(sessionId: string | null | undefined): string {
  return sessionId ? sessionId : ANON_CSRF_BINDING;
}

/** Mints a token for the binding. Set it in the CSRF cookie; the client sends it back in the header. */
export function issueCsrfToken(binding: string, secret: string): string {
  const nonce = randomToken(16);
  return `${nonce}.${hmacSha256(secret, `${nonce}:${binding}`)}`;
}

export type VerifyCsrfInput = {
  headerToken: string | null | undefined;
  cookieToken: string | null | undefined;
  binding: string;
  secret: string;
};

/** True when header and cookie carry the same token and its signature matches the binding. */
export function verifyCsrf({ headerToken, cookieToken, binding, secret }: VerifyCsrfInput): boolean {
  if (typeof headerToken !== "string" || typeof cookieToken !== "string") return false;
  if (headerToken.length === 0 || headerToken.length > MAX_TOKEN_LENGTH || cookieToken.length > MAX_TOKEN_LENGTH) return false;
  if (!safeEqual(headerToken, cookieToken)) return false;
  const parts = headerToken.split(".");
  if (parts.length !== 2) return false;
  const [nonce, signature] = parts;
  if (!nonce || !signature) return false;
  return safeEqual(signature, hmacSha256(secret, `${nonce}:${binding}`));
}

/** Routes that never use CSRF tokens (see the module comment). */
export function isCsrfExemptPath(pathname: string): boolean {
  return CSRF_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Defence in depth: rejects requests a browser marks as cross-site or whose Origin (else Referer) is not the
 * app's origin. Requests with neither header (non-browser clients) pass here; the token check still applies.
 */
export function sameOriginOk(req: { headers: Headers }, appUrl: string): boolean {
  let expected: string;
  try {
    expected = new URL(appUrl).origin;
  } catch {
    return false;
  }
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  if (origin !== null) return origin === expected; // includes the opaque "null" origin, which fails
  const referer = req.headers.get("referer");
  if (referer !== null) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  return true;
}

/** Reads one cookie from a Cookie header without depending on next/headers. */
export function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * Throws 403 `csrf_failed` unless the request passes the origin check and the double-submit check.
 * Call at the top of every cookie-authenticated mutating route handler (after resolving the session).
 */
export function assertCsrf(req: { headers: Headers }, opts: { binding: string; secret: string; appUrl: string }): void {
  const ok =
    sameOriginOk(req, opts.appUrl) &&
    verifyCsrf({
      headerToken: req.headers.get(CSRF_HEADER),
      cookieToken: readCookie(req.headers, CSRF_COOKIE),
      binding: opts.binding,
      secret: opts.secret,
    });
  if (!ok) throw errors.forbidden("Your session has changed. Refresh the page and try again.", "csrf_failed");
}
