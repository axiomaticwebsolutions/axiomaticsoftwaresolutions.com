/**
 * Content-Security-Policy (docs/security.md "Content-Security-Policy"; docs/decisions.md Phase 7).
 *
 * Two policies that differ only in `script-src`:
 * - STRICT (middleware.ts, per request): `'nonce-<random>' 'strict-dynamic'` plus the SHA-256 hashes of our own
 *   inline <head> scripts (lib/security/inline-scripts.ts). No 'unsafe-inline' for scripts. Next.js reads the nonce
 *   from the request's Content-Security-Policy header and puts it on every script it renders; scripts those scripts
 *   load (webpack chunks, Razorpay Checkout.js) are trusted through 'strict-dynamic'. Used on the dynamically
 *   rendered routes listed in strictCspRoute(): the portal, the admin console, checkout, order pages and the auth
 *   pages. A nonce only works on a page rendered per request, so these routes must stay dynamic.
 * - STATIC (next.config.ts, baked by `next build`): `'self' 'unsafe-inline'`. Prerendered and ISR storefront pages are
 *   served from the cache without a per-request nonce, and Next.js inlines the page's RSC payload as
 *   `self.__next_f.push(...)` scripts whose content differs per page and per revalidation, so they cannot be pinned
 *   by hash either (a hash source would also switch 'unsafe-inline' off). docs/security.md records the justification.
 *
 * Everything else is shared: default-src 'self', no plugins, no <base>, no framing by anyone, forms post to us only,
 * inline event-handler attributes refused (`script-src-attr 'none'`). Razorpay Checkout's origins are added only on
 * /checkout and /orders/:id. The storage upload origin (S3 bucket) is allowed in connect-src on every page: Next.js
 * client navigation keeps the CSP of the document it started in, so a policy that allowed it on /account/* and
 * /admin/* only would still block uploads after an in-app link from the storefront or an order page.
 *
 * Pure and edge-safe (no Node APIs, no imports): middleware.ts and next.config.ts both use it.
 */

/** Request header carrying the per-request nonce to server components (set by middleware.ts on strict routes). */
export const NONCE_HEADER = "x-nonce";

/**
 * Razorpay Checkout.js (Phase 3): the script, its modal iframes, its API and telemetry calls and its images.
 * With 'strict-dynamic' the script host is only a fallback for browsers without CSP level 3.
 */
export const RAZORPAY_CSP_SOURCES = {
  script: ["https://checkout.razorpay.com"],
  frame: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
  connect: ["https://api.razorpay.com", "https://lumberjack.razorpay.com"],
  img: ["https://*.razorpay.com"],
} as const;

/** The pages that open the Razorpay modal (`headers()` source patterns; next.config.ts sets COOP and Permissions-Policy). */
export const RAZORPAY_PAGE_PATTERNS = ["/checkout", "/orders/:id"] as const;

export type StrictScripts = {
  /** Base64 nonce for this response (generateNonce()). */
  nonce: string;
  /** `'sha256-...'` sources of our own inline scripts (inlineScriptHashSources()). */
  scriptHashes: readonly string[];
};

export type CspOptions = {
  /** `next dev`: adds 'unsafe-eval' (React refresh, eval source maps) and ws: (hot reload). */
  dev: boolean;
  /** The strict nonce policy; null or omitted gives the static policy. */
  strict?: StrictScripts | null;
  /** Razorpay Checkout.js sources (/checkout and /orders/:id only). */
  razorpay?: boolean;
  /** Origin browsers PUT presigned uploads to (lib/storage/upload-origin.ts); null for the local driver. */
  uploadOrigin?: string | null;
};

/** Builds the policy. `script-src` comes before `script-src-attr`: Next.js takes the nonce from the first directive starting with "script-src". */
export function contentSecurityPolicy(opts: CspOptions): string {
  const razorpay = opts.razorpay === true;
  const rz = (sources: readonly string[]): readonly string[] => (razorpay ? sources : []);
  const scriptSrc = opts.strict
    ? ["'self'", `'nonce-${opts.strict.nonce}'`, "'strict-dynamic'", ...opts.strict.scriptHashes, ...rz(RAZORPAY_CSP_SOURCES.script)]
    : ["'self'", "'unsafe-inline'", ...rz(RAZORPAY_CSP_SOURCES.script)];
  if (opts.dev) scriptSrc.push("'unsafe-eval'");
  const directives: [string, readonly string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    ["script-src-attr", ["'none'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", ...rz(RAZORPAY_CSP_SOURCES.img)]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...(opts.dev ? ["ws:"] : []), ...rz(RAZORPAY_CSP_SOURCES.connect), ...(opts.uploadOrigin ? [opts.uploadOrigin] : [])]],
    ["frame-src", ["'self'", ...rz(RAZORPAY_CSP_SOURCES.frame)]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    ["base-uri", ["'none'"]],
    ["object-src", ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

export type StrictCspRoute = { razorpay: boolean };

/** Auth and invitation pages (all rendered per request: they read the session). */
const STRICT_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/sign-in",
  "/register",
  "/forgot",
  "/reset",
  "/verify",
  "/invite",
  "/staff-invite",
]);

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** `/orders/<id>`: exactly one non-empty segment after /orders (deeper paths are the static 404 page). */
function isOrderPage(pathname: string): boolean {
  if (!pathname.startsWith("/orders/")) return false;
  const id = pathname.slice("/orders/".length);
  return id.length > 0 && !id.includes("/");
}

/**
 * The routes that get the strict nonce policy, or null for the static policy. Every route listed here must be rendered
 * per request (a prerendered page has no nonces and its scripts would be blocked); `/cart` is prerendered and stays
 * static. middleware.ts `config.matcher` must cover every path this returns a route for (tests/unit/security-csp.test.ts).
 */
export function strictCspRoute(pathname: string): StrictCspRoute | null {
  if (isUnder(pathname, "/account") || isUnder(pathname, "/admin")) return { razorpay: false };
  if (pathname === "/checkout" || isOrderPage(pathname)) return { razorpay: true };
  if (STRICT_EXACT_PATHS.has(pathname)) return { razorpay: false };
  return null;
}

/** 128 random bits, base64 (what Next.js accepts in `'nonce-...'`). Web Crypto, so it runs in the edge runtime. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
