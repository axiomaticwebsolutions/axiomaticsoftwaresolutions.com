/**
 * Request plumbing shared by the checkout and order route handlers: CSRF (same-origin + double-submit token bound to
 * the session, or "anon" when signed out), optional JSON bodies for the order action endpoints, and the order link
 * token from the body, the X-Order-Token header or the `?t=` query parameter.
 */
import type { z } from "zod";
import { assertCsrf, csrfBinding } from "@/lib/auth/csrf";
import { getEnv } from "@/lib/env";
import { parseJsonBody } from "@/lib/http";
import { ORDER_TOKEN_HEADER } from "@/lib/orders/token-header";

/** Longer values are no order link token (lib/orders/token.ts) and are ignored. */
const MAX_ORDER_TOKEN_LENGTH = 256;

/** Throws 403 `csrf_failed` unless the request is same-origin and carries the token for this session. */
export function assertCheckoutCsrf(req: { headers: Headers }, sessionId: string | null | undefined): void {
  const env = getEnv();
  assertCsrf(req, { binding: csrfBinding(sessionId), secret: env.CSRF_SECRET, appUrl: env.APP_URL });
}

/**
 * Parses a small JSON body that may be absent: no Content-Type and no body (or Content-Length 0) reads as {}.
 * Otherwise it is a normal strict parseJsonBody (415, 413, 400 invalid_json, 422).
 */
export async function parseOptionalJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const contentType = req.headers.get("content-type");
  const length = req.headers.get("content-length");
  if (req.body === null || length === "0" || (contentType === null && length === null)) {
    return schema.parseAsync({}) as Promise<z.output<S>>;
  }
  return parseJsonBody(req, schema, { maxBytes: opts.maxBytes ?? 2048 });
}

/**
 * The order link token: the body's `t` when given, else the X-Order-Token header (the order page's status polls;
 * lib/orders/token-header.ts), else the `?t=` query parameter (page links, invoice PDF), else null.
 */
export function orderTokenFrom(req: Request, bodyToken?: string | null): string | null {
  if (typeof bodyToken === "string" && bodyToken !== "") return bodyToken;
  const header = req.headers.get(ORDER_TOKEN_HEADER)?.trim();
  if (header) return header.length <= MAX_ORDER_TOKEN_LENGTH ? header : null;
  try {
    const t = new URL(req.url).searchParams.get("t");
    return t && t.length <= MAX_ORDER_TOKEN_LENGTH ? t : null;
  } catch {
    return null;
  }
}
