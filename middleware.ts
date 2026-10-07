/**
 * Edge middleware. Edge-safe on purpose: no database, no secrets, no server-only imports.
 *
 * 1. Strict Content-Security-Policy (docs/security.md): on the dynamically rendered routes (lib/security/csp.ts
 *    strictCspRoute: /account, /admin, /checkout, /orders/:id and the auth pages) every response gets a fresh nonce.
 *    The policy goes on the request (Next.js reads the nonce from the request's Content-Security-Policy header and puts
 *    it on the scripts it renders; `x-nonce` carries it for our own server code) and on the response, where it replaces
 *    the static policy from next.config.ts. Our own inline <head> scripts are allowed by hash.
 * 2. Optimistic redirect only (docs/decisions.md Phase 3 "Auth"): a visitor without the session cookie who opens
 *    /account/* or /admin/* goes to <APP_URL>/sign-in?next=<path> (publicOrigin below). The cookie's presence proves
 *    nothing; every page and route still authorizes on the server.
 * 3. Production guard for the development API (/api/dev/*): every method answers 404 there, so a production server
 *    never reveals that the routes exist (the handlers also refuse outside development; /dev/* pages 404 through
 *    app/dev/layout.tsx).
 * Other API routes, the static storefront, Next internals and static files never reach this (see `matcher`).
 */
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, generateNonce, NONCE_HEADER, strictCspRoute } from "@/lib/security/csp";
import { inlineScriptHashSources } from "@/lib/security/inline-scripts";
import { storageUploadOrigin } from "@/lib/storage/upload-origin";

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

let uploadOriginCache: { value: string | null } | null = null;

/** The storage bucket origin for connect-src, from the server's environment (computed once per process). */
function uploadOrigin(): string | null {
  uploadOriginCache ??= { value: storageUploadOrigin(process.env) };
  return uploadOriginCache.value;
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

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (isUnder(pathname, DEV_API_PREFIX)) {
    if (isDev()) return NextResponse.next();
    return NextResponse.json(
      { error: { code: "not_found", message: "Not found." } },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Everything the "/account/:path*" and "/admin/:path*" matchers let in (transport forms such as "/account.rsc" too).
  const signedInArea = pathname.startsWith("/account") || pathname.startsWith("/admin");
  if (signedInArea && !req.cookies.get(SESSION_COOKIE_NAME)?.value) {
    const url = new URL("/sign-in", publicOrigin(req));
    url.searchParams.set("next", `${pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(url);
  }

  const headers = new Headers(req.headers);
  if (signedInArea) headers.set(PATH_HEADER, `${pathname}${req.nextUrl.search}`);

  const route = strictCspRoute(pathname);
  if (!route) return NextResponse.next({ request: { headers } });

  const nonce = generateNonce();
  const policy = contentSecurityPolicy({
    dev: isDev(),
    strict: { nonce, scriptHashes: inlineScriptHashSources() },
    razorpay: route.razorpay,
    uploadOrigin: uploadOrigin(),
  });
  headers.set("content-security-policy", policy);
  headers.set(NONCE_HEADER, nonce);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", policy);
  return res;
}

export const config = {
  // Literal patterns (Next.js reads them at build time). They must cover every route strictCspRoute() accepts
  // ("/account/:path*" also matches "/account" itself) plus the development API; tests/unit/security-csp.test.ts checks it.
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
  ],
};
