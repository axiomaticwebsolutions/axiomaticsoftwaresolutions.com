/**
 * Content-Security-Policy (lib/security/csp.ts, inline-scripts.ts, sha256.ts) and the middleware that applies the
 * strict nonce policy (docs/security.md).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as pageStaticInfo from "next/dist/build/analysis/get-page-static-info";
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy, generateNonce, RAZORPAY_CSP_SOURCES, strictCspRoute } from "@/lib/security/csp";
import { BANNER_DISMISSED_KEY, BANNER_SCRIPT, INLINE_SCRIPTS, inlineScriptHashSources, sha256Source } from "@/lib/security/inline-scripts";
import { sha256 } from "@/lib/security/sha256";
import { PRICE_DISPLAY_SCRIPT } from "@/lib/storefront/price-display";
import { config, middleware } from "@/middleware";

/** Next.js's own compiler for middleware matchers (not in its type declarations). */
const { getMiddlewareMatchers } = pageStaticInfo as unknown as {
  getMiddlewareMatchers: (matcher: readonly string[], nextConfig: object) => { regexp: string }[];
};

const nodeSha = (text: string | Buffer) => createHash("sha256").update(text).digest("base64");

function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sha256 (edge-safe, synchronous)", () => {
  it("matches node:crypto across block boundaries and for non-ASCII text", () => {
    for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 70_000]) {
      const data = Buffer.alloc(length, 0);
      for (let i = 0; i < length; i++) data[i] = (i * 31 + 7) % 256;
      expect(Buffer.from(sha256(data)).toString("base64")).toBe(nodeSha(data));
    }
    expect(sha256Source("₹ prices — “GST”")).toBe(`'sha256-${nodeSha("₹ prices — “GST”")}'`);
    expect(Buffer.from(sha256(new TextEncoder().encode("abc"))).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("inline scripts allowed by hash", () => {
  it("lists the price-display and banner scripts with their exact SHA-256", () => {
    expect(INLINE_SCRIPTS).toEqual([PRICE_DISPLAY_SCRIPT, BANNER_SCRIPT]);
    expect(inlineScriptHashSources()).toEqual(INLINE_SCRIPTS.map((s) => `'sha256-${nodeSha(s)}'`));
  });

  it("keeps the banner script constant: the admin text travels in an escaped attribute", () => {
    const text = 'Diwali sale </script><script>alert(1)</script> & "quotes"';
    // components/store/site-banner.tsx renders exactly this element (Vitest cannot import .tsx with JSX).
    const source = readFileSync("components/store/site-banner.tsx", "utf8");
    expect(source).toContain('<script id="site-banner-script" data-banner-text={text} dangerouslySetInnerHTML={{ __html: BANNER_SCRIPT }} />');
    const html = renderToStaticMarkup(
      createElement("script", { id: "site-banner-script", "data-banner-text": text, dangerouslySetInnerHTML: { __html: BANNER_SCRIPT } }),
    );
    const inner = /^<script [^>]*>([\s\S]*)<\/script>$/.exec(html)?.[1];
    expect(inner).toBe(BANNER_SCRIPT);
    expect(BANNER_SCRIPT).not.toContain("Diwali");
    expect(html).toContain('data-banner-text="Diwali sale &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;"');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("hides a dismissed banner before paint and remembers a dismissal", () => {
    const attrs = new Map<string, string>();
    const storage = new Map<string, string>();
    let onClick: ((e: unknown) => void) | null = null;
    let focused = false;
    const document = {
      documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) },
      currentScript: { getAttribute: (k: string) => (k === "data-banner-text" ? "Sale now" : null) },
      addEventListener: (_type: string, fn: (e: unknown) => void) => (onClick = fn),
      getElementById: () => ({ focus: () => (focused = true) }),
    };
    const sessionStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) };
    const run = () => new Function("document", "sessionStorage", BANNER_SCRIPT)(document, sessionStorage);
    run();
    expect(attrs.has("data-banner-dismissed")).toBe(false);
    const button = { closest: (sel: string) => (sel === "[data-banner-dismiss]" ? {} : null) };
    (onClick as unknown as (e: unknown) => void)({ target: button });
    expect(storage.get(BANNER_DISMISSED_KEY)).toBe("Sale now");
    expect(attrs.has("data-banner-dismissed")).toBe(true);
    expect(focused).toBe(true);
    attrs.clear();
    run();
    expect(attrs.has("data-banner-dismissed")).toBe(true);
  });
});

describe("contentSecurityPolicy", () => {
  const strict = { nonce: "bm9uY2Vub25jZW5vbmNlMQ==", scriptHashes: ["'sha256-AAAA'", "'sha256-BBBB'"] };

  it("static policy: 'unsafe-inline' scripts, no nonce, no Razorpay, the shared lockdown directives", () => {
    const d = directives(contentSecurityPolicy({ dev: false }));
    expect(d.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d.get("script-src-attr")).toEqual(["'none'"]);
    expect(d.get("default-src")).toEqual(["'self'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'none'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    expect(d.get("connect-src")).toEqual(["'self'"]);
    expect(d.get("frame-src")).toEqual(["'self'"]);
  });

  it("strict policy: nonce + 'strict-dynamic' + hashes, never 'unsafe-inline' or 'unsafe-eval' in production", () => {
    const policy = contentSecurityPolicy({ dev: false, strict });
    const script = directives(policy).get("script-src") ?? [];
    expect(script).toEqual(["'self'", `'nonce-${strict.nonce}'`, "'strict-dynamic'", "'sha256-AAAA'", "'sha256-BBBB'"]);
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    // Next.js finds the nonce (it reads the first directive starting with "script-src").
    expect(policy.indexOf("script-src ")).toBeLessThan(policy.indexOf("script-src-attr"));
    expect(getScriptNonceFromHeader(policy)).toBe(strict.nonce);
  });

  it("adds Razorpay only when asked, the upload origin to connect-src, and dev-only eval and websockets", () => {
    const rz = directives(contentSecurityPolicy({ dev: false, strict, razorpay: true, uploadOrigin: "https://axs-files.s3.ap-south-1.amazonaws.com" }));
    expect(rz.get("script-src")).toContain(RAZORPAY_CSP_SOURCES.script[0]);
    expect(rz.get("frame-src")).toEqual(["'self'", ...RAZORPAY_CSP_SOURCES.frame]);
    expect(rz.get("connect-src")).toEqual(["'self'", ...RAZORPAY_CSP_SOURCES.connect, "https://axs-files.s3.ap-south-1.amazonaws.com"]);
    expect(rz.get("img-src")).toEqual(["'self'", "data:", "blob:", ...RAZORPAY_CSP_SOURCES.img]);
    const dev = directives(contentSecurityPolicy({ dev: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toContain("ws:");
    expect(contentSecurityPolicy({ dev: false })).not.toMatch(/razorpay|unsafe-eval|ws:/);
  });
});

describe("strictCspRoute", () => {
  it("covers the dynamic areas and leaves the prerendered storefront static", () => {
    for (const path of ["/account", "/account/tickets/new", "/admin", "/admin/releases", "/sign-in", "/register", "/forgot", "/reset", "/verify", "/invite", "/staff-invite"]) {
      expect(strictCspRoute(path), path).toEqual({ razorpay: false });
    }
    for (const path of ["/checkout", "/orders/AX-10386"]) expect(strictCspRoute(path), path).toEqual({ razorpay: true });
    for (const path of ["/", "/cart", "/pricing", "/software", "/software/medical-billing", "/docs/install", "/orders", "/orders/a/b", "/accounting", "/administrator", "/sign-in/x", "/api/v1/licenses/validate", "/dev/mailbox"]) {
      expect(strictCspRoute(path), path).toBeNull();
    }
  });

  it("is covered by the middleware matcher, which leaves the storefront and the device API alone", () => {
    const matchers = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
    const matched = (path: string) => matchers.some((re) => re.test(path));
    for (const path of ["/account", "/account/licenses/LIC-1", "/admin", "/admin/staff", "/checkout", "/orders/AX-1", "/sign-in", "/register", "/forgot", "/reset", "/verify", "/invite", "/staff-invite", "/api/dev/storage/x"]) {
      expect(matched(path), path).toBe(true);
    }
    for (const path of ["/", "/cart", "/pricing", "/software/medical-billing", "/orders", "/api/v1/licenses/validate", "/api/auth/sign-in", "/_next/static/chunks/x.js"]) {
      expect(matched(path), path).toBe(false);
      expect(strictCspRoute(path), path).toBeNull();
    }
  });

  it("makes 128-bit base64 nonces, a new one each time", () => {
    const nonces = new Set(Array.from({ length: 50 }, generateNonce));
    expect(nonces.size).toBe(50);
    for (const n of nonces) expect(Buffer.from(n, "base64")).toHaveLength(16);
  });
});

describe("middleware strict CSP", () => {
  const request = (path: string, cookie = "axs_session=opaque-token") => new NextRequest(`http://localhost:3000${path}`, { headers: { cookie } });
  /** The request headers middleware hands to the page (NextResponse.next({ request: { headers } })). */
  const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

  it("sends a fresh nonce policy on the response and on the forwarded request, with x-nonce", () => {
    const a = middleware(request("/account/licenses"));
    const b = middleware(request("/account/licenses"));
    const policy = a.headers.get("content-security-policy") ?? "";
    const nonce = getScriptNonceFromHeader(policy);
    expect(nonce).toBeTruthy();
    expect(getScriptNonceFromHeader(b.headers.get("content-security-policy") ?? "")).not.toBe(nonce);
    expect(forwarded(a, "content-security-policy")).toBe(policy);
    expect(forwarded(a, "x-nonce")).toBe(nonce);
    expect(forwarded(a, "x-axs-path")).toBe("/account/licenses");
    expect(a.headers.get("x-middleware-next")).toBe("1");
    for (const hash of inlineScriptHashSources()) expect(directives(policy).get("script-src")).toContain(hash);
    expect(policy).not.toContain("razorpay");
  });

  it("allows Razorpay on /checkout and order pages only, and needs no session there", () => {
    for (const path of ["/checkout", "/orders/AX-10386?t=o1.x"]) {
      const res = middleware(request(path, ""));
      expect(res.status, path).toBe(200);
      expect(directives(res.headers.get("content-security-policy") ?? "").get("frame-src"), path).toContain("https://api.razorpay.com");
      expect(forwarded(res, "x-axs-path"), path).toBeNull();
    }
    expect(middleware(request("/sign-in", "")).headers.get("content-security-policy")).not.toContain("razorpay");
  });

  it("leaves other paths without a policy of its own (next.config.ts sends the static one)", () => {
    const res = middleware(request("/"));
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(forwarded(res, "x-nonce")).toBeNull();
  });

  it("redirects a signed-out visitor of /account before minting anything, and adds the upload origin from the environment", async () => {
    const out = middleware(request("/account/tickets/new", ""));
    expect(out.status).toBe(307);
    expect(out.headers.get("content-security-policy")).toBeNull();
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("STORAGE_BUCKET", "axs-files");
    vi.stubEnv("STORAGE_REGION", "ap-south-1");
    vi.resetModules();
    const fresh = (await import("@/middleware")).middleware;
    const policy = fresh(request("/admin/releases")).headers.get("content-security-policy") ?? "";
    expect(directives(policy).get("connect-src")).toContain("https://axs-files.s3.ap-south-1.amazonaws.com");
    expect(directives(policy).get("script-src")).toContain("'unsafe-eval'"); // NODE_ENV=test counts as development
  });
});
