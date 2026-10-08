/**
 * Middleware, Node.js runtime (docs/admin-integrations-design.md section 11; docs/security.md). No secrets in responses;
 * the only server-side state it reads is the integration resolver's cached snapshot (the bucket origin).
 *
 * 1. Content-Security-Policy on EVERY page (the matcher covers all paths except /api and /_next, plus /api/dev):
 *    - strict routes (lib/security/csp.ts strictCspRoute: /account, /admin, /checkout, /orders/:id and the auth pages)
 *      get a fresh nonce policy. It goes on the request (Next.js reads the nonce from the request's
 *      Content-Security-Policy header and puts it on the scripts it renders; `x-nonce` carries it for our own server
 *      code) and on the response. Our own inline <head> scripts are allowed by hash.
 *    - every other page gets the static policy ('unsafe-inline' scripts, for prerendered and ISR pages).
 *    Both carry the storage bucket origin in connect-src from the RUNTIME storage configuration
 *    (lib/integrations/csp-origin.ts: Admin > Settings > Integrations, else the env fallback; one exact origin, never a
 *    wildcard), so a bucket change needs no rebuild. The bucket must be on every page because client-side navigation
 *    keeps the first document's policy. The middleware's header replaces next.config.ts's (which has no bucket).
 *    The Node.js runtime runs in the server process, so this module's copy of the resolver shares the process-wide
 *    snapshot (globalThis) and sees a save in this process at once; other processes within 30 s.
 * 2. Optimistic redirect only (docs/decisions.md Phase 3 "Auth"): a visitor without the session cookie who opens
 *    /account, /account/*, /admin or /admin/* goes to <APP_URL>/sign-in?next=<path> (publicOrigin below). The cookie's
 *    presence proves nothing; every page and route still authorizes on the server. /accounting or /administrator are
 *    not signed-in areas.
 * 3. Uploaded branding files (/brand/*, Admin > Settings > Branding) get BRAND_ASSET_CSP instead of a page policy: an SVG
 *    opened directly then loads and runs nothing (sandbox). The route sets the same header, but a header set here wins.
 * 4. Production guard for the development API (/api/dev/*): every method answers 404 there, so a production server
 *    never reveals that the routes exist (the handlers also refuse outside development; /dev/* pages 404 through
 *    app/dev/layout.tsx).
 * Other API routes and Next internals (/_next) never reach this (see `matcher`).
 */
import { NextResponse, type NextRequest } from "next/server";
import { uploadOriginForCsp } from "@/lib/integrations/csp-origin";
import { BRAND_ASSET_CSP, contentSecurityPolicy, generateNonce, isBrandAssetPath, NONCE_HEADER, strictCspRoute } from "@/lib/security/csp";
import { inlineScriptHashSources } from "@/lib/security/inline-scripts";

/** Must equal SESSION_COOKIE in lib/auth/cookies.ts (a unit test checks it; that module is server-only). */
const SESSION_COOKIE_NAME = "axs_session";

const DEV_API_PREFIX = "/api/dev";

/**
 * Must equal PORTAL_PATH_HEADER in lib/portal/context.ts: the requested path + query, forwarded to the server so the
 * portal layout can send an expired session to /sign-in?next=<path> and an unverified customer to /verify?next=<path>
 * (layouts cannot read the URL otherwise). Always overwritten here, so a client cannot supply it; the server only uses
 * it as a redirect target after safeNext().
 */
const PATH_HEADER = "x-axs-path";

/** Read per request (webpack inlines it in builds; tests stub it). */
const isDev = () => process.env.NODE_ENV !== "production";

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** `/account`, `/account/...` and transport forms such as `/account.rsc` (same for /admin); not `/accounting`. */
function inSignedInArea(pathname: string, prefix: string): boolean {
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length);
  return rest === "" || rest.startsWith("/") || /^[.][A-Za-z0-9]+$/.test(rest);
}

/**
 * The site's public origin for redirects: APP_URL's origin (https://<domain> in production), else the request's own.
 * Never req.nextUrl in production: `next start -H 127.0.0.1` behind aaPanel Nginx hands middleware an internal URL
 * (http(s)://localhost:<port>), and Next.js only makes a middleware Location relative when its origin equals the
 * server's own -H origin (https://127.0.0.1:<port>), so browsers would be sent to https://localhost:3000/sign-in. A
 * relative Location is no way out either: Next.js parses middleware redirects as absolute URLs. Read per request
 * (the server's environment; tests stub it). docs/decisions.md "Phase 7 review fixes".
 */
function publicOrigin(req: NextRequest): string {
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // Not a URL: lib/env.ts reports it; fall back to the request's origin.
    }
  }
  return req.nextUrl.origin;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (isUnder(pathname, DEV_API_PREFIX)) {
    if (isDev()) return NextResponse.next();
    return NextResponse.json(
      { error: { code: "not_found", message: "Not found." } },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (isBrandAssetPath(pathname)) {
    const headers = new Headers(req.headers);
    headers.delete("content-security-policy");
    headers.delete(NONCE_HEADER);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("Content-Security-Policy", BRAND_ASSET_CSP);
    return res;
  }

  const signedInArea = inSignedInArea(pathname, "/account") || inSignedInArea(pathname, "/admin");
  if (signedInArea && !req.cookies.get(SESSION_COOKIE_NAME)?.value) {
    const url = new URL("/sign-in", publicOrigin(req));
    url.searchParams.set("next", `${pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(url);
  }

  const headers = new Headers(req.headers);
  if (signedInArea) headers.set(PATH_HEADER, `${pathname}${req.nextUrl.search}`);
  const uploadOrigin = await uploadOriginForCsp();

  const route = strictCspRoute(pathname);
  if (!route) {
    // The static policy has no nonce, so a client-sent CSP or nonce request header must not reach the renderer either.
    headers.delete("content-security-policy");
    headers.delete(NONCE_HEADER);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("Content-Security-Policy", contentSecurityPolicy({ dev: isDev(), uploadOrigin }));
    return res;
  }

  const nonce = generateNonce();
  const policy = contentSecurityPolicy({
    dev: isDev(),
    strict: { nonce, scriptHashes: inlineScriptHashSources() },
    razorpay: route.razorpay,
    uploadOrigin,
  });
  headers.set("content-security-policy", policy);
  headers.set(NONCE_HEADER, nonce);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", policy);
  return res;
}

export const config = {
  // Node.js runtime: the bucket origin comes from the integration resolver (database + process-wide cache).
  runtime: "nodejs",
  // Literal patterns (Next.js reads them at build time): the strict routes listed explicitly (strictCspRoute;
  // "/account/:path*" also matches "/account"), the development API, and every other page (the last pattern: all paths
  // except /api and /_next). tests/unit/security-csp.test.ts checks what is and is not covered.
  matcher: [
    "/account/:path*",
    "/admin/:path*",
    "/api/dev/:path*",
    "/checkout",
    "/orders/:id",
    "/sign-in",
    "/register",
    "/forgot",
    "/reset",
    "/verify",
    "/invite",
    "/staff-invite",
    "/((?!api/|_next/).*)",
  ],
};
