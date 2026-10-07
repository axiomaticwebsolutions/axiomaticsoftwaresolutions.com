import { describe, expect, it } from "vitest";
import {
  ANON_CSRF_BINDING,
  CSRF_COOKIE,
  CSRF_HEADER,
  assertCsrf,
  csrfBinding,
  isCsrfExemptPath,
  issueCsrfToken,
  readCookie,
  sameOriginOk,
  verifyCsrf,
} from "@/lib/auth/csrf";
import { ApiError } from "@/lib/http";

const SECRET = "test-csrf-secret-0123456789abcdef0123456789";
const APP_URL = "https://axiomatic.example";

describe("issueCsrfToken / verifyCsrf", () => {
  it("accepts a token echoed in header and cookie for the same binding", () => {
    const token = issueCsrfToken("sess_1", SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyCsrf({ headerToken: token, cookieToken: token, binding: "sess_1", secret: SECRET })).toBe(true);
  });

  it("rejects a token minted for another binding", () => {
    const token = issueCsrfToken("sess_1", SECRET);
    expect(verifyCsrf({ headerToken: token, cookieToken: token, binding: "sess_2", secret: SECRET })).toBe(false);
    const anon = issueCsrfToken(ANON_CSRF_BINDING, SECRET);
    expect(verifyCsrf({ headerToken: anon, cookieToken: anon, binding: "sess_1", secret: SECRET })).toBe(false);
    expect(verifyCsrf({ headerToken: anon, cookieToken: anon, binding: csrfBinding(null), secret: SECRET })).toBe(true);
  });

  it("rejects a header that differs from the cookie, even when both are valid", () => {
    const a = issueCsrfToken("sess_1", SECRET);
    const b = issueCsrfToken("sess_1", SECRET);
    expect(a).not.toBe(b);
    expect(verifyCsrf({ headerToken: a, cookieToken: b, binding: "sess_1", secret: SECRET })).toBe(false);
  });

  it("rejects tampered, forged, malformed and missing tokens", () => {
    const token = issueCsrfToken("sess_1", SECRET);
    const [nonce, sig] = token.split(".") as [string, string];
    const flip = (s: string) => (s.endsWith("A") ? `${s.slice(0, -1)}B` : `${s.slice(0, -1)}A`);
    const cases = [
      `${flip(nonce)}.${sig}`,
      `${nonce}.${flip(sig)}`,
      `${nonce}.`,
      `.${sig}`,
      nonce,
      `${token}.extra`,
      issueCsrfToken("sess_1", "another-secret-0123456789abcdef0123"),
      "x".repeat(300),
    ];
    for (const bad of cases) {
      expect(verifyCsrf({ headerToken: bad, cookieToken: bad, binding: "sess_1", secret: SECRET }), bad).toBe(false);
    }
    expect(verifyCsrf({ headerToken: null, cookieToken: token, binding: "sess_1", secret: SECRET })).toBe(false);
    expect(verifyCsrf({ headerToken: token, cookieToken: undefined, binding: "sess_1", secret: SECRET })).toBe(false);
    expect(verifyCsrf({ headerToken: "", cookieToken: "", binding: "sess_1", secret: SECRET })).toBe(false);
  });
});

describe("sameOriginOk", () => {
  const req = (h: Record<string, string>) => ({ headers: new Headers(h) });

  it("checks Origin first, then Referer", () => {
    expect(sameOriginOk(req({ origin: APP_URL }), APP_URL)).toBe(true);
    expect(sameOriginOk(req({ origin: "https://evil.example" }), APP_URL)).toBe(false);
    expect(sameOriginOk(req({ origin: "null" }), APP_URL)).toBe(false);
    expect(sameOriginOk(req({ referer: `${APP_URL}/checkout?x=1` }), APP_URL)).toBe(true);
    expect(sameOriginOk(req({ referer: "https://evil.example/axiomatic.example" }), APP_URL)).toBe(false);
    expect(sameOriginOk(req({ referer: "not a url" }), APP_URL)).toBe(false);
  });

  it("rejects requests the browser marks cross-site and lets header-less clients through", () => {
    expect(sameOriginOk(req({ "sec-fetch-site": "cross-site", origin: APP_URL }), APP_URL)).toBe(false);
    expect(sameOriginOk(req({}), APP_URL)).toBe(true);
  });
});

describe("assertCsrf", () => {
  it("passes with matching cookie and header and throws 403 csrf_failed otherwise", () => {
    const token = issueCsrfToken("sess_9", SECRET);
    const good = { headers: new Headers({ origin: APP_URL, cookie: `a=1; ${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: token }) };
    expect(() => assertCsrf(good, { binding: "sess_9", secret: SECRET, appUrl: APP_URL })).not.toThrow();

    const missing = { headers: new Headers({ origin: APP_URL, cookie: `${CSRF_COOKIE}=${token}` }) };
    try {
      assertCsrf(missing, { binding: "sess_9", secret: SECRET, appUrl: APP_URL });
      throw new Error("expected assertCsrf to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).code).toBe("csrf_failed");
    }
  });
});

describe("helpers", () => {
  it("exempts webhooks and the device API only", () => {
    expect(isCsrfExemptPath("/api/webhooks/payments/razorpay")).toBe(true);
    expect(isCsrfExemptPath("/api/v1/licenses/activate")).toBe(true);
    expect(isCsrfExemptPath("/api/account/licenses/LIC-1/reveal")).toBe(false);
    expect(isCsrfExemptPath("/api/webhooksx")).toBe(false);
  });

  it("reads cookies from a Cookie header", () => {
    const headers = new Headers({ cookie: "axs_session=abc; axs_csrf=n.s%3D; other=1" });
    expect(readCookie(headers, "axs_csrf")).toBe("n.s=");
    expect(readCookie(headers, "missing")).toBeNull();
    expect(readCookie(new Headers(), "axs_csrf")).toBeNull();
  });
});
