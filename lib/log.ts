/**
 * Tiny structured JSON logger: one line per event, `{ time, level, event, ...fields }`.
 *
 * Every field passes through redact(): values under sensitive keys become "[redacted]", license-key-shaped
 * substrings are masked to the product code and last 4 characters, URLs anywhere in text (strings, URL objects,
 * Next's NextURL) lose their query string, fragment and user:password, "Bearer <token>" and "token=<value>" style
 * credentials in text are masked, and Errors lose their stack in production.
 * Logging never throws.
 */
import { isProduction } from "@/lib/env";
import { redactLicenseKeys } from "@/lib/licensing/keys";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
/** Receives one serialized JSON line. Replaceable for tests via setLogSink(). */
export type LogSink = (level: LogLevel, line: string) => void;

export const REDACTED = "[redacted]";

const SENSITIVE_KEY = new RegExp(
  [
    "key", // licenseKey, apiKey, privateKey ...
    "passw(?:or)?d",
    "pass(?:phrase|code)",
    "pass$", // smtpPass, { user, pass }
    "pwd",
    "token",
    "secret",
    "authorization",
    "cookie",
    "otp",
    "code",
    "card",
    "vpa",
    "upi",
    "jwt",
    "signature",
    "sig$", // hmacSig, x-sig (not signedAt / design)
    "pepper",
    "pem",
    "credential",
    "dsn",
    "databaseurl",
    "connectionstring",
    "challenge", // two-step challenge ids ("<id>.<secret>")
    "nonce", // CSP nonces
    "csrf",
    "hmac",
    "salt",
  ].join("|"),
  "i",
);
// scheme://[user:pass@]host/path[?query][#fragment] inside any text. Userinfo may contain "@", so it runs to the last
// "@" before the path. Query strings carry guest-order tokens and presigned signatures; userinfo carries passwords.
const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"'<>]*@)?([^\s?#"'<>]*)([?#][^\s"'<>]*)?/gi;
// A bare path with a query ("GET /orders/AX-1?t=...") at the start of the text or after a space, quote, = or comma.
const PATH_QUERY_IN_TEXT = /(^|[\s("'=,])(\/[^\s?#"'<>]*)([?#][^\s"'<>]*)/g;
// Credentials in free text (error messages that echo request headers): "Bearer <token>" anywhere, and whatever follows
// "Authorization:" / "authorization=" (Basic, Digest, custom schemes).
const BEARER_IN_TEXT = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const AUTH_HEADER_IN_TEXT = /\b(authorization["']?\s*[:=]\s*["']?)[^\s"',;]+(?:\s+[^\s"',;]+)?/gi;
// "name=value" pairs outside a URL query ("X-Amz-Signature=...", "token=..." in an error message).
const SECRET_PARAM_IN_TEXT = /\b([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|signature|credential|api_?key|otp))=([^\s&"'<>;,]+)/gi;
// Names that match SENSITIVE_KEY but are safe by definition: the API contract says to log keyLast4 only.
const SAFE_KEYS = new Set(["keylast4", "last4", "keymasked", "errorcode", "statuscode"]);
const MAX_DEPTH = 8;
const MAX_ARRAY = 100;
const MAX_STRING = 4000;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) && !SAFE_KEYS.has(key.toLowerCase());
}

const redactedTail = (tail: string | undefined) => (tail ? `${tail.charAt(0)}${REDACTED}` : "");

function maskUrls(text: string): string {
  return text
    .replace(
      URL_IN_TEXT,
      (_m, scheme: string, userinfo: string | undefined, rest: string, tail: string | undefined) =>
        `${scheme}${userinfo ? `${REDACTED}@` : ""}${rest}${redactedTail(tail)}`,
    )
    .replace(PATH_QUERY_IN_TEXT, (_m, lead: string, path: string, tail: string) => `${lead}${path}${redactedTail(tail)}`);
}

function maskSecretsInText(text: string): string {
  return text
    .replace(BEARER_IN_TEXT, `Bearer ${REDACTED}`)
    .replace(AUTH_HEADER_IN_TEXT, (_m, lead: string) => `${lead}${REDACTED}`)
    .replace(SECRET_PARAM_IN_TEXT, (_m, name: string) => `${name}=${REDACTED}`);
}

function maskText(text: string): string {
  const masked = maskSecretsInText(maskUrls(redactLicenseKeys(text)));
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…[truncated]` : masked;
}

/** WHATWG URLs and look-alikes such as Next's NextURL (not a URL subclass; its toJSON returns the full href). */
function urlHref(obj: object): string | null {
  if (obj instanceof URL) return obj.href;
  const candidate = obj as { href?: unknown; searchParams?: unknown };
  return typeof candidate.href === "string" && candidate.searchParams instanceof URLSearchParams ? candidate.href : null;
}

function serializeError(err: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: maskText(err.message) };
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out.errorCode = code;
  for (const [k, v] of Object.entries(err)) {
    if (k === "code" || k === "message" || k === "stack" || k === "cause" || k in out) continue;
    out[k] = isSensitiveKey(k) && v != null ? REDACTED : walk(v, depth + 1, seen);
  }
  if (err.cause !== undefined) out.cause = walk(err.cause, depth + 1, seen);
  if (!isProduction() && err.stack) out.stack = maskText(err.stack);
  return out;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return maskText(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
    case "function":
      return `[${typeof value}]`;
    default:
      break;
  }
  const obj = value as object;
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);
  try {
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
    if (obj instanceof Error) return serializeError(obj, depth, seen);
    if (ArrayBuffer.isView(obj)) return `[binary ${obj.byteLength} bytes]`;
    if (obj instanceof ArrayBuffer) return `[binary ${obj.byteLength} bytes]`;
    const href = urlHref(obj);
    if (href !== null) return maskText(href);
    if (obj instanceof URLSearchParams) return REDACTED;
    if (typeof Headers !== "undefined" && obj instanceof Headers) return walk(Object.fromEntries(obj.entries()), depth, seen);
    if (obj instanceof Map) return walk(Object.fromEntries(obj), depth, seen);
    if (obj instanceof Set) return walk([...obj], depth, seen);
    if (Array.isArray(obj)) {
      const items = obj.slice(0, MAX_ARRAY).map((v) => walk(v, depth + 1, seen));
      if (obj.length > MAX_ARRAY) items.push(`[${obj.length - MAX_ARRAY} more]`);
      return items;
    }
    const toJSON = (obj as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return walk((toJSON as () => unknown).call(obj), depth + 1, seen);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = isSensitiveKey(k) && v != null ? REDACTED : walk(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Returns a JSON-safe, redacted copy of `value` (exported for tests and for code that persists diagnostics). */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};

let sink: LogSink = consoleSink;

/** Replaces the output sink (tests). Pass null to restore console output. Returns the previous sink. */
export function setLogSink(next: LogSink | null): LogSink {
  const previous = sink;
  sink = next ?? consoleSink;
  return previous;
}

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  try {
    const line: Record<string, unknown> = { time: new Date().toISOString(), level, event: maskText(event) };
    if (fields) {
      const clean = redact(fields);
      if (clean && typeof clean === "object") {
        for (const [k, v] of Object.entries(clean)) if (!(k in line)) line[k] = v;
      }
    }
    sink(level, JSON.stringify(line));
  } catch {
    try {
      sink("error", JSON.stringify({ time: new Date().toISOString(), level: "error", event: "log_failed" }));
    } catch {
      // A broken sink must never take the request down with it.
    }
  }
}

export const log = {
  info: (event: string, fields?: LogFields): void => emit("info", event, fields),
  warn: (event: string, fields?: LogFields): void => emit("warn", event, fields),
  error: (event: string, fields?: LogFields): void => emit("error", event, fields),
};
