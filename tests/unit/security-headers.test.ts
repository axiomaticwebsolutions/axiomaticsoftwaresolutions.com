/**
 * Static security headers (next.config.ts headers(), lib/security/headers.ts). The strict nonce CSP of the dynamic
 * routes is middleware.ts (tests/unit/security-csp.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  baseSecurityHeaders,
  hstsHeaderValue,
  parseHstsStrict,
  PERMISSIONS_POLICY,
  PERMISSIONS_POLICY_RAZORPAY,
} from "@/lib/security/headers";

type HeaderEntry = { source: string; headers: { key: string; value: string }[] };

async function entries(): Promise<HeaderEntry[]> {
  vi.resetModules();
  const nextConfig = (await import("@/next.config")).default;
  if (!nextConfig.headers) throw new Error("next.config.ts defines no headers()");
  return (await nextConfig.headers()) as HeaderEntry[];
}

const header = (entry: HeaderEntry | undefined, key: string) => entry?.headers.find((h) => h.key === key)?.value ?? null;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("security headers (next.config.ts)", () => {
  it("sends the baseline headers on every path, with the static CSP (no nonce, no Razorpay)", async () => {
    const [all] = await entries();
    expect(all?.source).toBe("/:path*");
    const csp = header(all, "Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/nonce-|strict-dynamic|razorpay/);
    expect(header(all, "X-Content-Type-Options")).toBe("nosniff");
    expect(header(all, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header(all, "X-Frame-Options")).toBe("DENY");
    expect(header(all, "Permissions-Policy")).toBe(PERMISSIONS_POLICY);
    expect(header(all, "Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(header(all, "X-Permitted-Cross-Domain-Policies")).toBe("none");
    // Vitest runs with NODE_ENV=test: development headers, so no HSTS.
    expect(header(all, "Strict-Transport-Security")).toBeNull();
  });

  it("relaxes COOP and the payment permission on the Razorpay pages only, listed after the catch-all", async () => {
    const list = await entries();
    expect(list.slice(1).map((e) => e.source)).toEqual(["/checkout", "/orders/:id"]);
    for (const entry of list.slice(1)) {
      expect(entry.headers.map((h) => h.key).sort()).toEqual(["Cross-Origin-Opener-Policy", "Permissions-Policy"]);
      expect(header(entry, "Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
      expect(header(entry, "Permissions-Policy")).toBe(PERMISSIONS_POLICY_RAZORPAY);
    }
    expect(PERMISSIONS_POLICY).toContain("payment=(self)");
    expect(PERMISSIONS_POLICY_RAZORPAY).toContain('payment=(self "https://api.razorpay.com" "https://checkout.razorpay.com")');
    for (const policy of [PERMISSIONS_POLICY, PERMISSIONS_POLICY_RAZORPAY]) expect(policy).toMatch(/^camera=\(\), microphone=\(\), geolocation=\(\)/);
  });

  it("puts the storage upload origin in the static connect-src when the build has STORAGE_* set", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("STORAGE_BUCKET", "axs-files");
    vi.stubEnv("STORAGE_REGION", "ap-south-1");
    const [all] = await entries();
    expect(header(all, "Content-Security-Policy")).toMatch(/connect-src 'self'[^;]* https:\/\/axs-files\.s3\.ap-south-1\.amazonaws\.com/);
  });

  it("stops the build on an invalid SECURITY_HSTS_STRICT", async () => {
    vi.stubEnv("SECURITY_HSTS_STRICT", "ture");
    await expect(entries()).rejects.toThrow("SECURITY_HSTS_STRICT must be true or false");
  });
});

describe("Strict-Transport-Security", () => {
  it("is one year by default and adds includeSubDomains; preload only when strict", () => {
    expect(hstsHeaderValue(false)).toBe("max-age=31536000");
    expect(hstsHeaderValue(true)).toBe("max-age=31536000; includeSubDomains; preload");
    const prod = baseSecurityHeaders({ csp: "default-src 'self'", dev: false, hstsStrict: false });
    expect(prod.find((h) => h.key === "Strict-Transport-Security")?.value).toBe("max-age=31536000");
    const strict = baseSecurityHeaders({ csp: "default-src 'self'", dev: false, hstsStrict: true });
    expect(strict.find((h) => h.key === "Strict-Transport-Security")?.value).toBe("max-age=31536000; includeSubDomains; preload");
    expect(baseSecurityHeaders({ csp: "x", dev: true, hstsStrict: true }).some((h) => h.key === "Strict-Transport-Security")).toBe(false);
  });

  it("reads SECURITY_HSTS_STRICT like lib/env.ts booleans", () => {
    for (const v of [undefined, "", "false", "0", "no", " FALSE ", '"false"']) expect(parseHstsStrict(v), String(v)).toBe(false);
    for (const v of ["true", "1", "yes", "TRUE", "'1'"]) expect(parseHstsStrict(v), v).toBe(true);
    for (const v of ["ture", "on", "2"]) expect(() => parseHstsStrict(v)).toThrow();
  });
});
