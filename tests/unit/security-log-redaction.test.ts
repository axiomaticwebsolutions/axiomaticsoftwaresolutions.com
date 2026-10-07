/**
 * Redaction coverage of lib/log.ts for the secrets this app handles (Phase 7 security review; tests/unit/log.test.ts
 * covers the basics). Every value below must never reach a log line.
 */
import { describe, expect, it } from "vitest";
import { redact, REDACTED } from "@/lib/log";

const line = (value: unknown) => JSON.stringify(redact(value));

describe("log redaction coverage", () => {
  it("redacts auth secrets by key: challenge ids, CSP nonces, CSRF tokens, HMACs and salts", () => {
    const out = redact({
      challengeId: "cm1.SECRETSECRET",
      nonce: "bm9uY2U=",
      csrf: "c1",
      xCsrf: "c2",
      "x-csrf-token": "c3",
      hmac: "deadbeef",
      salt: "s1",
      sessionToken: "t1",
      resetUrl: "https://axiomatic.example/reset?token=abc.def",
    }) as Record<string, unknown>;
    for (const k of ["challengeId", "nonce", "csrf", "xCsrf", "x-csrf-token", "hmac", "salt", "sessionToken"]) expect(out[k], k).toBe(REDACTED);
    // Not a sensitive name, but the value is a URL whose query is the secret.
    expect(out.resetUrl).toBe("https://axiomatic.example/reset?[redacted]");
  });

  it("keeps ids and operational fields readable", () => {
    expect(redact({ sessionId: "cmabc", userId: "u1", orderId: "AX-10312", path: "/account/licenses", revokedSessions: 2 })).toEqual({
      sessionId: "cmabc",
      userId: "u1",
      orderId: "AX-10312",
      path: "/account/licenses",
      revokedSessions: 2,
    });
  });

  it("masks credentials that error messages echo in free text", () => {
    const text = line({
      error: "fetch failed: Authorization: Basic dXNlcjpwYXNzd29yZA== (401); retry with Bearer eyJhbGciOiJFZERTQSJ9.payload.sig",
    });
    expect(text).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(text).not.toContain("eyJhbGciOiJFZERTQSJ9");
    expect(text).toContain("Bearer [redacted]");
    expect(line({ message: "presign X-Amz-Signature=abc123&X-Amz-Credential=AKIAEXAMPLE/2026 X-Amz-Security-Token=tok" })).not.toMatch(
      /abc123|AKIAEXAMPLE|=tok/,
    );
    expect(line({ message: "bad request token=o1.123.abc password=hunter22 api_key=k1 otp=123456" })).not.toMatch(/o1\.123|hunter22|=k1|123456/);
  });

  it("masks order-link tokens, reset links and connection strings wherever they appear", () => {
    const text = line({
      a: "GET /orders/AX-10312?t=o1.1790000000.tag.sig",
      b: "see https://axiomatic.example/reset?token=id.secret#x",
      c: "postgresql://axiomatic:dbpass@127.0.0.1:5432/axiomatic",
      d: "redis://:redispass@127.0.0.1:6379",
    });
    expect(text).not.toMatch(/o1\.1790000000|id\.secret|dbpass|redispass/);
  });

  it("does not mangle ordinary words", () => {
    expect(redact("Basic plan renewed; Bearer of the order: Priya; token budget")).toBe("Basic plan renewed; Bearer of the order: Priya; token budget");
  });
});
