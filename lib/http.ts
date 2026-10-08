/**
 * Route-handler plumbing: typed API errors, the `{ error: { code, message, ...details } }` envelope,
 * bounded JSON body parsing, and client IP helpers.
 */
import { isIP } from "node:net";
import { unstable_rethrow } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { databaseUnavailableReason, type DatabaseUnavailableReason } from "@/lib/db-errors";
import { getEnv, isProduction } from "@/lib/env";
import { log } from "@/lib/log";

export type ApiErrorOptions = { details?: Record<string, unknown>; headers?: Record<string, string> };

const API_ERROR_BRAND = Symbol.for("axs.http.ApiError");

/** An error with an HTTP status and a stable machine-readable code. The message is user-facing copy. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, opts: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = opts.details;
    this.headers = opts.headers;
    Object.defineProperty(this, API_ERROR_BRAND, { value: true });
  }

  /**
   * `instanceof ApiError` checks a brand, not the prototype chain: Next.js bundles instrumentation.ts and the route
   * handlers as separate module graphs, so an ApiError thrown by code registered at start-up (the Redis rate-limit
   * store's 503) comes from another copy of this class and must still map to its status in errorResponse().
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { [API_ERROR_BRAND]?: unknown })[API_ERROR_BRAND] === true;
  }
}

/** Field path ("billing.gstin") -> messages. */
export type FieldErrors = Record<string, string[]>;

export const VALIDATION_MESSAGE = "Please fix the highlighted fields.";
export const INTERNAL_ERROR_MESSAGE = "Something went wrong on our side. Please try again.";
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** 503 `unavailable` when the database is saturated or unreachable (pool wait or statement timeout, lost connection). */
export const SERVICE_UNAVAILABLE_MESSAGE = "We can’t complete this request right now. Please try again in a moment.";
export const SERVICE_UNAVAILABLE_RETRY_SEC = 5;
/** At most one "database_unavailable" log line per process per this interval (a saturated pool fails every request). */
const UNAVAILABLE_LOG_INTERVAL_MS = 10_000;

function rateLimitMessage(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Too many attempts. Try again in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
}

export const errors = {
  badRequest: (code = "bad_request", message = "The request couldn’t be processed.", details?: Record<string, unknown>) =>
    new ApiError(400, code, message, { details }),
  unauthorized: () => new ApiError(401, "unauthorized", "Sign in to continue."),
  forbidden: (message = "You don’t have permission to do that.", code = "forbidden") => new ApiError(403, code, message),
  notFound: (what?: string) => new ApiError(404, "not_found", what ? `${what} not found.` : "Not found."),
  conflict: (code: string, message: string, details?: Record<string, unknown>) => new ApiError(409, code, message, { details }),
  validation: (fieldErrors: Record<string, string | string[]>, formErrors: string[] = []) => {
    const normalized: FieldErrors = {};
    for (const [k, v] of Object.entries(fieldErrors)) normalized[k] = Array.isArray(v) ? v : [v];
    return new ApiError(422, "validation_failed", VALIDATION_MESSAGE, { details: { fieldErrors: normalized, formErrors } });
  },
  rateLimited: (retryAfterSec: number, message?: string) => {
    const seconds = Math.max(1, Math.ceil(retryAfterSec));
    return new ApiError(429, "too_many_attempts", message ?? rateLimitMessage(seconds), {
      details: { retryAfterSec: seconds },
      headers: { "Retry-After": String(seconds) },
    });
  },
  payloadTooLarge: (maxBytes: number) =>
    new ApiError(413, "payload_too_large", "The request is too large.", { details: { maxBytes } }),
  unsupportedMediaType: () => new ApiError(415, "unsupported_media_type", "Send the request body as JSON."),
  invalidJson: () => new ApiError(400, "invalid_json", "The request body isn’t valid JSON."),
};

/** Dotted-path field errors from a Zod error (nested objects keep their full path, unlike z.flattenError). */
export function zodFieldErrors(error: z.core.$ZodError): { fieldErrors: FieldErrors; formErrors: string[] } {
  const fieldErrors: FieldErrors = {};
  const formErrors: string[] = [];
  const add = (path: string, message: string) => {
    if (path === "") formErrors.push(message);
    else (fieldErrors[path] ??= []).push(message);
  };
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) add(path ? `${path}.${key}` : key, "Unknown field.");
    } else {
      add(path, issue.message);
    }
  }
  return { fieldErrors, formErrors };
}

/** 422 validation_failed built from a Zod error. */
export function validationErrorFromZod(error: z.core.$ZodError): ApiError {
  const { fieldErrors, formErrors } = zodFieldErrors(error);
  return errors.validation(fieldErrors, formErrors);
}

function withDefaultHeaders(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers);
  // API responses are private by default; cacheable endpoints (catalog) set their own Cache-Control.
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return { ...init, headers };
}

/** JSON response with `Cache-Control: no-store` unless the caller sets one. */
export function json<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, withDefaultHeaders(init));
}

export type ErrorBody = { error: { code: string; message: string } & Record<string, unknown> };

function errorBody(code: string, message: string, details?: Record<string, unknown>): ErrorBody {
  const error: ErrorBody["error"] = { code, message };
  for (const [k, v] of Object.entries(details ?? {})) if (k !== "code" && k !== "message") error[k] = v;
  return { error };
}

export type ErrorContext = { method?: string; path?: string };

const unavailableLog = { lastAt: 0, suppressed: 0 };

function logUnavailable(reason: DatabaseUnavailableReason, context: ErrorContext): void {
  const nowMs = Date.now();
  if (nowMs - unavailableLog.lastAt < UNAVAILABLE_LOG_INTERVAL_MS) {
    unavailableLog.suppressed += 1;
    return;
  }
  log.warn("database_unavailable", { ...context, reason, suppressedSinceLast: unavailableLog.suppressed });
  unavailableLog.lastAt = nowMs;
  unavailableLog.suppressed = 0;
}

/**
 * Maps any thrown value to the error envelope. Database saturation or outages (databaseUnavailableReason) become 503
 * `unavailable` with Retry-After, so clients back off instead of piling up; other unknown errors are logged
 * (redacted) and become a generic 500.
 */
export function errorResponse(e: unknown, context: ErrorContext = {}): NextResponse<ErrorBody> {
  if (e instanceof ApiError) {
    return json(errorBody(e.code, e.message, e.details), { status: e.status, headers: e.headers });
  }
  if (e instanceof z.core.$ZodError) {
    const v = validationErrorFromZod(e);
    return json(errorBody(v.code, v.message, v.details), { status: v.status });
  }
  const unavailable = databaseUnavailableReason(e);
  if (unavailable) {
    logUnavailable(unavailable, context);
    return json(errorBody("unavailable", SERVICE_UNAVAILABLE_MESSAGE, { retryAfterSec: SERVICE_UNAVAILABLE_RETRY_SEC }), {
      status: 503,
      headers: { "Retry-After": String(SERVICE_UNAVAILABLE_RETRY_SEC) },
    });
  }
  log.error("unhandled_error", { ...context, error: e });
  return json(errorBody("internal_error", INTERNAL_ERROR_MESSAGE), { status: 500 });
}

const warnedSchemas = new WeakSet<object>();

/** Body schemas must reject unknown keys; flag non-strict object schemas during development. */
function warnIfNotStrict(schema: z.ZodType): void {
  if (isProduction() || warnedSchemas.has(schema) || !(schema instanceof z.ZodObject)) return;
  const catchall = schema.def.catchall;
  if (catchall && catchall._zod.def.type === "never") return;
  warnedSchemas.add(schema);
  log.warn("non_strict_body_schema", { hint: "use z.strictObject() or .strict() for request bodies" });
}

async function readLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw errors.payloadTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Reads a raw (non-JSON) request body of at most `maxBytes`: 413 `payload_too_large` past it, counted while streaming,
 * so a missing or wrong Content-Length cannot get more through (branding uploads).
 */
export async function readRawBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  return readLimited(req, maxBytes);
}

function isJsonMediaType(contentType: string | null): boolean {
  const media = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(media);
}

/**
 * Reads and validates a JSON request body.
 * 415 for a non-JSON content type, 413 above `maxBytes` (checked while streaming, not only via Content-Length),
 * 400 `invalid_json` for unparseable bodies, 422 `validation_failed` when the schema rejects it.
 * Schemas are expected to be strict (unknown keys rejected).
 */
export async function parseJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!isJsonMediaType(req.headers.get("content-type"))) throw errors.unsupportedMediaType();
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw errors.payloadTooLarge(maxBytes);
  warnIfNotStrict(schema);

  const bytes = await readLimited(req, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw errors.invalidJson();
  }
  if (text.trim() === "") throw errors.invalidJson();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw errors.invalidJson();
  }
  const parsed = await schema.safeParseAsync(data);
  if (!parsed.success) throw validationErrorFromZod(parsed.error);
  return parsed.data;
}

/**
 * Wraps a route handler so thrown ApiErrors, Zod errors and unexpected errors become the JSON error envelope.
 * Next.js control-flow errors (redirect(), notFound()) are re-thrown untouched.
 */
export function route<C = unknown>(
  handler: (req: NextRequest, ctx: C) => Promise<Response> | Response,
): (req: NextRequest, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      unstable_rethrow(e);
      let path: string | undefined;
      try {
        path = new URL(req.url).pathname;
      } catch {
        path = undefined;
      }
      return errorResponse(e, { method: req.method, path });
    }
  };
}

// ---------- Client IP ----------

function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v); // "[2001:db8::1]:443"
  if (bracketed?.[1]) v = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":")); // "1.2.3.4:5678"
  v = v.replace(/%.*$/, "").toLowerCase(); // IPv6 zone id
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped?.[1]) v = mapped[1];
  return isIP(v) === 0 ? null : v;
}

/**
 * Client IP from X-Forwarded-For, trusting exactly `trustedProxyHops` appending proxies (ALB = 1,
 * CloudFront + ALB = 2): the entry that many places from the right is the address the outermost trusted proxy saw.
 * Entries further left are client-supplied and never used. With 0 trusted proxies nothing is trusted and the result
 * is null: Next.js fills X-Forwarded-For from the socket only when the client sent none, so a forged header looks
 * the same. X-Real-IP is never trusted. Fewer entries than proxies (a request that skipped a hop) falls back to the
 * left-most entry, so the origin must only accept traffic from the proxy chain.
 * Exported for tests; app code calls clientIp(), which applies TRUSTED_PROXY_HOPS.
 */
export function clientIpFromHeaders(headers: Pick<Headers, "get">, trustedProxyHops: number): string | null {
  if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 0) {
    throw new RangeError("trustedProxyHops must be a non-negative integer.");
  }
  if (trustedProxyHops === 0) return null;
  const xff = headers.get("x-forwarded-for");
  if (!xff) return null;
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return normalizeIp(hops[Math.max(0, hops.length - trustedProxyHops)]);
}

/**
 * The requesting client's IP as this deployment can trust it (TRUSTED_PROXY_HOPS), or null when unknown.
 * The only entry point for route handlers and server actions (`clientIp({ headers: await headers() })`), so
 * per-IP rate limits and stored IP prefixes always use the configured trust.
 */
export function clientIp(req: { headers: Pick<Headers, "get"> }): string | null {
  return clientIpFromHeaders(req.headers, getEnv().TRUSTED_PROXY_HOPS);
}

function ipv6Groups(ip: string): number[] | null {
  let text = ip;
  const tail: number[] = [];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const b = v4.slice(1).map(Number);
    tail.push(((b[0] ?? 0) << 8) | (b[1] ?? 0), ((b[2] ?? 0) << 8) | (b[3] ?? 0));
    text = text.slice(0, v4.index) + "0"; // placeholder group, dropped below
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string | undefined) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  let head = parse(halves[0]);
  let rest = halves.length === 2 ? parse(halves[1]) : [];
  if (tail.length) {
    if (rest.length) rest = rest.slice(0, -1);
    else head = head.slice(0, -1);
  }
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function ipv6Network(ip: string, groupCount: number): string | null {
  const groups = ipv6Groups(ip);
  return groups ? `${groups.slice(0, groupCount).map((g) => g.toString(16)).join(":")}::/${groupCount * 16}` : null;
}

/** Truncated IP for display and audit: "103.21.44.x", or the IPv6 /48 network ("2001:db8:85a3::/48"). */
export function ipPrefix(ip: string | null | undefined): string | null {
  const v = normalizeIp(ip);
  if (!v) return null;
  if (isIP(v) === 4) return `${v.split(".").slice(0, 3).join(".")}.x`;
  return ipv6Network(v, 3);
}

/** Rate-limit identity for an IP: the full IPv4 address, or the IPv6 /64 (one subscriber's allocation). */
export function ipBucket(ip: string | null | undefined): string {
  const v = normalizeIp(ip);
  if (!v) return "unknown";
  return isIP(v) === 4 ? v : (ipv6Network(v, 4) ?? v);
}
