/**
 * Post-authentication redirects. Client-safe (no server imports), so auth pages and route handlers share it.
 *
 * `next` comes from the query string or a request body and is attacker-controlled. safeNext() only ever returns a
 * same-origin relative path ("/account/licenses?tab=keys"): no scheme, no host, no protocol-relative "//", no
 * backslashes or control characters (browsers treat "/\evil.example" as a host), never an API route or one of the
 * auth pages themselves (which would loop).
 */

export const MAX_NEXT_LENGTH = 2048;

/** Auth pages a successful sign-in must never send the user back to. */
export const AUTH_PAGE_PATHS = ["/sign-in", "/register", "/verify", "/forgot", "/reset"] as const;

export const CUSTOMER_HOME = "/account";
export const STAFF_HOME = "/admin";
export const VERIFY_PATH = "/verify";
export const SIGN_IN_PATH = "/sign-in";

const PROBE_ORIGIN = "http://next.invalid";

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function hasUnsafeCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // C0 controls, DEL, backslash
    if (c < 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

/** The validated same-origin path for `next`, or null when it is missing or unsafe. */
export function safeNext(next: unknown): string | null {
  if (typeof next !== "string") return null;
  const value = next.trim();
  if (value === "" || value.length > MAX_NEXT_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (hasUnsafeCharacters(value)) return null;
  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  const path = url.pathname;
  if (isUnder(path, "/api") || isUnder(path, "/_next")) return null;
  if (AUTH_PAGE_PATHS.some((p) => isUnder(path, p))) return null;
  return `${path}${url.search}${url.hash}`;
}

export type RedirectSubject = { kind: "CUSTOMER" | "STAFF"; emailVerified: boolean };

/** Home of a user kind: staff land in the admin console, customers in the portal. */
export function homeFor(kind: RedirectSubject["kind"]): string {
  return kind === "STAFF" ? STAFF_HOME : CUSTOMER_HOME;
}

/** `/verify`, carrying a safe `next` along so verification can finish the journey. */
export function verifyPath(next?: string | null): string {
  const safe = safeNext(next);
  return safe ? `${VERIFY_PATH}?next=${encodeURIComponent(safe)}` : VERIFY_PATH;
}

/** `/sign-in?next=<path>` (the middleware and pages use it for signed-out visitors). */
export function signInPath(next?: string | null): string {
  const safe = safeNext(next);
  return safe ? `${SIGN_IN_PATH}?next=${encodeURIComponent(safe)}` : SIGN_IN_PATH;
}

/**
 * Where a user goes after signing in (or finishing two-step sign-in):
 * staff -> `next` inside /admin, else /admin; unverified customers -> /verify (keeping `next`);
 * verified customers -> `next` (never /admin), else /account.
 */
export function redirectAfterSignIn(subject: RedirectSubject, next?: string | null): string {
  const safe = safeNext(next);
  if (subject.kind === "STAFF") return safe && isUnder(new URL(safe, PROBE_ORIGIN).pathname, STAFF_HOME) ? safe : STAFF_HOME;
  const customerNext = safe && !isUnder(new URL(safe, PROBE_ORIGIN).pathname, STAFF_HOME) ? safe : null;
  if (!subject.emailVerified) return verifyPath(customerNext);
  return customerNext ?? CUSTOMER_HOME;
}

/** Where a customer goes once the email is verified: a safe `next` (never /admin), else the portal. */
export function redirectAfterVerification(next?: string | null): string {
  const safe = safeNext(next);
  if (safe && !isUnder(new URL(safe, PROBE_ORIGIN).pathname, STAFF_HOME)) return safe;
  return CUSTOMER_HOME;
}
