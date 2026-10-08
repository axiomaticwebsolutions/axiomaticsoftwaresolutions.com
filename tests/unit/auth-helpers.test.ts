import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  emailHint,
  invalidCredentialsError,
  signInLockedError,
  splitOpaqueToken,
} from "@/lib/auth/flows/common";
import { deviceLabel } from "@/lib/auth/flows/me";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { config, middleware } from "@/middleware";

describe("auth copy helpers", () => {
  it("uses one invalid-credentials message, with attempts left after the third attempt", () => {
    expect(invalidCredentialsError(1, 5).message).toBe("Email or password is incorrect.");
    expect(invalidCredentialsError(2, 5).message).toBe("Email or password is incorrect.");
    expect(invalidCredentialsError(3, 5).message).toBe("Email or password is incorrect. 2 attempts left.");
    expect(invalidCredentialsError(4, 5).message).toBe("Email or password is incorrect. 1 attempt left.");
    expect(invalidCredentialsError(5, 5).message).toBe("Email or password is incorrect.");
    expect(invalidCredentialsError(1, 5)).toMatchObject({ status: 401, code: "invalid_credentials" });
  });

  it("locks with the prototype message and a Retry-After header", () => {
    const e = signInLockedError(14 * 60 + 5);
    expect(e).toMatchObject({ status: 429, code: "too_many_attempts", headers: { "Retry-After": "845" } });
    expect(e.message).toBe("Too many attempts. Try again in 15 minutes, or reset your password.");
    expect(signInLockedError(30).message).toBe("Too many attempts. Try again in 1 minute, or reset your password.");
  });

  it("hints an email address without revealing it", () => {
    expect(emailHint("priya@sharmamedicals.example")).toBe("p•••@sharmamedicals.example");
    expect(emailHint("a@b.example")).toBe("a•••@b.example");
  });

  it("splits opaque tokens and refuses malformed ones", () => {
    const secret = "A".repeat(43);
    expect(splitOpaqueToken(`cmabc123.${secret}`)).toEqual({ id: "cmabc123", secret });
    for (const bad of ["", "nodot", `.${secret}`, "id.short", `a.b.${secret}`, `id.${secret}!`, `${"i".repeat(70)}.${secret}`]) {
      expect(splitOpaqueToken(bad)).toBeNull();
    }
  });

  it("labels devices from the user agent", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/129.0 Safari/537.36 Edg/129.0")).toBe("Edge on Windows");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15")).toBe("Safari on macOS");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Linux");
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel("curl/8.0")).toBe("Unknown device");
  });
});

describe("middleware", () => {
  const request = (path: string, cookie?: string) =>
    new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });

  it("redirects signed-out visitors of /account and /admin to sign-in with next", async () => {
    const res = await middleware(request("/account/licenses?status=active"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe("/account/licenses?status=active");
    expect(new URL((await middleware(request("/admin"))).headers.get("location") ?? "").searchParams.get("next")).toBe("/admin");
  });

  it("lets requests with the session cookie through (the server still authorizes)", async () => {
    const res = await middleware(request("/account", `${SESSION_COOKIE}=opaque-token`));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects to APP_URL's origin, never the internal URL next start hands middleware behind the proxy", async () => {
    // Production: `next start -H 127.0.0.1` behind aaPanel Nginx gives middleware http(s)://localhost:<port>/... and
    // Next.js forwards an absolute Location whose origin differs from 127.0.0.1 as it is (docs/decisions.md Phase 7).
    vi.stubEnv("APP_URL", "https://axiomaticsoftwaresolutions.com");
    try {
      expect((await middleware(request("/account"))).headers.get("location")).toBe("https://axiomaticsoftwaresolutions.com/sign-in?next=%2Faccount");
      const internal = new NextRequest("https://localhost:3197/admin/orders?status=review", {
        headers: { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      });
      expect((await middleware(internal)).headers.get("location")).toBe(
        "https://axiomaticsoftwaresolutions.com/sign-in?next=%2Fadmin%2Forders%3Fstatus%3Dreview",
      );
      vi.stubEnv("APP_URL", "https://axiomaticsoftwaresolutions.com/");
      expect(new URL((await middleware(request("/account/licenses"))).headers.get("location") ?? "").origin).toBe("https://axiomaticsoftwaresolutions.com");
      // Without a usable APP_URL (unit tests, a broken env that lib/env.ts reports) the request's own origin is used.
      vi.stubEnv("APP_URL", "not a url");
      expect((await middleware(request("/account"))).headers.get("location")).toBe("http://localhost:3000/sign-in?next=%2Faccount");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("treats an empty session cookie as signed out", async () => {
    expect((await middleware(request("/account", `${SESSION_COOKIE}=`))).status).toBe(307);
  });

  it("matches the signed-in areas and the development API (plus the strict-CSP pages, tests/unit/security-csp.test.ts)", () => {
    expect(config.matcher).toEqual(expect.arrayContaining(["/account/:path*", "/admin/:path*", "/api/dev/:path*"]));
  });

  it("answers 404 for every development API request in production, and passes it through in development", async () => {
    expect((await middleware(request("/api/dev/mock-checkout"))).headers.get("x-middleware-next")).toBe("1");
    vi.stubEnv("NODE_ENV", "production");
    try {
      for (const path of ["/api/dev/mock-checkout", "/api/dev/mock-checkout/bank", "/api/dev"]) {
        const res = await middleware(request(path, `${SESSION_COOKIE}=opaque-token`));
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
      }
      // The signed-in areas are unaffected.
      expect((await middleware(request("/account"))).status).toBe(307);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
