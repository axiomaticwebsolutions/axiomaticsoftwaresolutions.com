/**
 * Scheduler auth for /api/cron/*: `Authorization: Bearer <CRON_SECRET>`, compared in constant time (safeEqual hashes
 * both sides, so neither the secret's content nor its length leaks through timing). Cron requests carry no cookies,
 * so these routes have no CSRF token or same-origin check; the bearer secret (at least 256 bits) is their gate.
 * Not rate limited: brute force is impractical and a lockout would stop the real scheduler.
 */
import "server-only";
import { safeEqual } from "@/lib/auth/tokens";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;
const MAX_HEADER_LENGTH = 1024;

export const CRON_UNAUTHORIZED_MESSAGE = "Missing or invalid cron credentials.";

/** True when the request carries `Authorization: Bearer <secret>`. */
export function isCronAuthorized(req: { headers: Headers }, secret: string = getEnv().CRON_SECRET): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (header.length > MAX_HEADER_LENGTH) return false;
  const match = BEARER.exec(header);
  // Compare even without a match, so a malformed header takes the same path as a wrong secret.
  return safeEqual(match?.[1] ?? "", secret) && match !== null;
}

/** Throws 401 `unauthorized` (with WWW-Authenticate) unless the request carries the cron secret. */
export function assertCronAuthorized(req: { headers: Headers }): void {
  if (!isCronAuthorized(req)) {
    throw new ApiError(401, "unauthorized", CRON_UNAUTHORIZED_MESSAGE, {
      headers: { "WWW-Authenticate": 'Bearer realm="cron"' },
    });
  }
}
