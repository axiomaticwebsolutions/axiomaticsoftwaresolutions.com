/**
 * Browser helper for the app's own JSON API (client components only).
 *
 * - Same-origin paths only ("/api/..."), so cookies and the CSRF token never go to another host.
 * - Mutations (POST, PUT, PATCH, DELETE) send the double-submit token: the readable `axs_csrf` cookie echoed in
 *   `x-csrf-token`. When the cookie is missing it first calls GET /api/csrf. A 403 `csrf_failed` (the session changed,
 *   e.g. after signing in elsewhere) fetches a fresh token and retries once; the server rejected the first attempt
 *   before doing anything, so the retry is safe.
 * - Errors arrive as ApiClientError with the server's envelope { error: { code, message, ...details } }.
 */
import { CSRF_COOKIE, CSRF_HEADER } from "@/lib/auth/csrf-names";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiFetchOptions = {
  /** Defaults to GET, or POST when a body is given. */
  method?: HttpMethod;
  /** Sent as JSON. */
  body?: unknown;
  /** A file sent as the raw body (Content-Type application/octet-stream), instead of `body`. */
  file?: Blob;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export const NETWORK_ERROR_MESSAGE = "We couldn’t reach the server. Check your connection and try again.";
export const UNEXPECTED_ERROR_MESSAGE = "Something went wrong on our side. Please try again.";

/** An API error: HTTP status (0 = network failure), stable code, user-facing message and any extra fields. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field path -> messages from a 422 `validation_failed` response ({} otherwise). */
  get fieldErrors(): Record<string, string[]> {
    const value = this.details.fieldErrors;
    if (!value || typeof value !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [key, messages] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(messages)) out[key] = messages.filter((m): m is string => typeof m === "string");
    }
    return out;
  }
}

const MUTATING: ReadonlySet<HttpMethod> = new Set<HttpMethod>(["POST", "PUT", "PATCH", "DELETE"]);

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return value || null;
    }
  }
  return null;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Builds an ApiClientError from an error response (the JSON envelope when present). */
async function errorFrom(res: Response): Promise<ApiClientError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const envelope = (body as { error?: unknown } | null)?.error;
  if (envelope && typeof envelope === "object") {
    const { code, message, ...details } = envelope as Record<string, unknown>;
    if (typeof code === "string" && typeof message === "string") {
      return new ApiClientError(res.status, code, message, details);
    }
  }
  return new ApiClientError(res.status, `http_${res.status}`, UNEXPECTED_ERROR_MESSAGE);
}

async function send(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiClientError(0, "network_error", NETWORK_ERROR_MESSAGE);
  }
}

let pendingToken: Promise<string> | null = null;

/** Mints a fresh CSRF token (GET /api/csrf also sets the cookie). Concurrent callers share one request. */
export function refreshCsrfToken(): Promise<string> {
  pendingToken ??= (async () => {
    const res = await send("/api/csrf", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw await errorFrom(res);
    const data = (await res.json()) as { token?: unknown };
    if (typeof data.token !== "string" || data.token === "") {
      throw new ApiClientError(res.status, "invalid_response", UNEXPECTED_ERROR_MESSAGE);
    }
    return data.token;
  })().finally(() => {
    pendingToken = null;
  });
  return pendingToken;
}

/** The current CSRF token: the cookie, or a fresh one from the server. */
export async function csrfToken(): Promise<string> {
  return readCookie(CSRF_COOKIE) ?? refreshCsrfToken();
}

/**
 * Calls the app's API and returns the parsed JSON body (undefined for 204). Throws ApiClientError for HTTP errors
 * and network failures; an aborted request rethrows the AbortError untouched.
 */
export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("apiFetch only calls this site's own paths, such as /api/...");
  }
  const method: HttpMethod = opts.method ?? (opts.body === undefined && opts.file === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.file !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = opts.file;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const request = (token: string | null) =>
    send(path, {
      method,
      body,
      signal: opts.signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: token ? { ...headers, [CSRF_HEADER]: token } : headers,
    });

  const mutating = MUTATING.has(method);
  let res = await request(mutating ? await csrfToken() : null);
  if (!res.ok && mutating && res.status === 403) {
    const error = await errorFrom(res);
    if (error.code !== "csrf_failed") throw error;
    res = await request(await refreshCsrfToken());
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204 || res.status === 205) return undefined as T;
  const text = await res.text();
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiClientError(res.status, "invalid_response", UNEXPECTED_ERROR_MESSAGE);
  }
}
