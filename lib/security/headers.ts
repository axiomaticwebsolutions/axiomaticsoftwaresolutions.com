/**
 * Response security headers set by next.config.ts `headers()` (computed by `next build`, so a change needs a deploy).
 * The Content-Security-Policy is lib/security/csp.ts; middleware.ts replaces it with the strict nonce policy on the
 * dynamic routes. docs/security.md explains each header.
 *
 * Pure (relative imports only), because next.config.ts imports it.
 */
import { RAZORPAY_CSP_SOURCES } from "./csp";

export type HeaderEntry = { key: string; value: string };

/** One year: the default for the test-mode release (docs/decisions.md Phase 7). */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * `max-age=31536000`, plus `includeSubDomains; preload` when SECURITY_HSTS_STRICT is on. Turn that on before live sales,
 * once every subdomain serves HTTPS: preload lists are hard to leave, and includeSubDomains also binds every subdomain.
 */
export function hstsHeaderValue(strict: boolean): string {
  return strict ? `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload` : `max-age=${HSTS_MAX_AGE_SECONDS}`;
}

const TRUE_VALUES = new Set(["true", "1", "yes"]);
const FALSE_VALUES = new Set(["false", "0", "no"]);

/**
 * SECURITY_HSTS_STRICT as lib/env.ts reads it (true/false/1/0/yes/no, unset = false). next.config.ts cannot use
 * getEnv() (the whole environment is not present at build time), so it parses this one variable itself and stops the
 * build on a typo instead of silently sending the weaker header.
 */
export function parseHstsStrict(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase();
  if (value === "") return false;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error("SECURITY_HSTS_STRICT must be true or false (1/0, yes/no).");
}

const DISABLED_FEATURES = ["camera", "microphone", "geolocation", "usb", "serial", "hid", "bluetooth", "midi", "display-capture", "browsing-topics"];

function permissionsPolicy(paymentAllowlist: string): string {
  return [...DISABLED_FEATURES.map((f) => `${f}=()`), `payment=(${paymentAllowlist})`].join(", ");
}

/** Every page: powerful features off; the Payment Request API for our own origin only. */
export const PERMISSIONS_POLICY = permissionsPolicy("self");

/** Razorpay pages: its checkout iframes may also use the Payment Request API (UPI and wallet apps). */
export const PERMISSIONS_POLICY_RAZORPAY = permissionsPolicy(["self", ...RAZORPAY_CSP_SOURCES.frame.map((o) => `"${o}"`)].join(" "));

/**
 * Cross-Origin-Opener-Policy. same-origin severs every cross-origin window reference (tabnabbing, XS-leaks). The
 * Razorpay pages use same-origin-allow-popups: the payment modal opens bank, 3-D Secure and wallet windows and must
 * keep a handle on them; a page that opens us is still cut off.
 */
export const COOP = "same-origin";
export const COOP_RAZORPAY = "same-origin-allow-popups";

/** The headers every response gets (`/:path*`), the static CSP included. */
export function baseSecurityHeaders(opts: { csp: string; dev: boolean; hstsStrict: boolean }): HeaderEntry[] {
  return [
    { key: "Content-Security-Policy", value: opts.csp },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "Cross-Origin-Opener-Policy", value: COOP },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
    // Browsers ignore HSTS over http; development stays plain http on localhost.
    ...(opts.dev ? [] : [{ key: "Strict-Transport-Security", value: hstsHeaderValue(opts.hstsStrict) }]),
  ];
}

/** Overrides for the pages that open the Razorpay modal (listed after the catch-all: the later entry wins). */
export const RAZORPAY_PAGE_HEADERS: readonly HeaderEntry[] = [
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY_RAZORPAY },
  { key: "Cross-Origin-Opener-Policy", value: COOP_RAZORPAY },
];
