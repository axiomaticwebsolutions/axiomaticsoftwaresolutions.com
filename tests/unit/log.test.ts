import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED, log, redact, setLogSink, type LogLevel } from "@/lib/log";

const KEY = "MED-7Q4K-9XTP-W2HD-K8NM";

function capture() {
  const lines: Array<{ level: LogLevel; data: Record<string, unknown> }> = [];
  setLogSink((level, line) => lines.push({ level, data: JSON.parse(line) as Record<string, unknown> }));
  return lines;
}

afterEach(() => {
  setLogSink(null);
  vi.unstubAllEnvs();
});

describe("redact: sensitive keys", () => {
  it("redacts every sensitive key name, case-insensitively", () => {
    const out = redact({
      licenseKey: KEY,
      password: "hunter2hunter2",
      currentPassword: "x",
      token: "abc",
      sessionToken: "abc",
      clientSecret: "s",
      Authorization: "Bearer abc",
      cookie: "axs_session=abc",
      otp: "123456",
      code: "246810",
      cardNumber: "4111111111111111",
      vpa: "priya@okbank",
      upiId: "priya@okbank",
      apiKey: "k",
      email: "priya@sharmamedicals.example",
      orderId: "AX-10312",
    }) as Record<string, unknown>;
    for (const k of [
      "licenseKey",
      "password",
      "currentPassword",
      "token",
      "sessionToken",
      "clientSecret",
      "Authorization",
      "cookie",
      "otp",
      "code",
      "cardNumber",
      "vpa",
      "upiId",
      "apiKey",
    ]) {
      expect(out[k], k).toBe(REDACTED);
    }
    expect(out.email).toBe("priya@sharmamedicals.example");
    expect(out.orderId).toBe("AX-10312");
  });

  it("redacts password, signature and connection-string style keys too", () => {
    const keys = [
      "pwd",
      "passphrase",
      "pass",
      "smtpPass",
      "jwt",
      "sig",
      "hmacSig",
      "signature",
      "pepper",
      "pem",
      "privatePem",
      "dsn",
      "credentials",
      "awsCredential",
      "databaseUrl",
      "connectionString",
    ];
    const out = redact(Object.fromEntries(keys.map((k) => [k, "value"]))) as Record<string, unknown>;
    for (const k of keys) expect(out[k], k).toBe(REDACTED);
    expect(redact({ signedAt: "2026-10-06", design: "card-grid", passengers: 2 })).toEqual({
      signedAt: "2026-10-06",
      design: "card-grid",
      passengers: 2,
    });
  });

  it("keeps the explicitly safe keyLast4 and keeps null values visible", () => {
    expect(redact({ keyLast4: "K8NM", token: null, password: undefined })).toEqual({
      keyLast4: "K8NM",
      token: null,
      password: undefined,
    });
  });

  it("walks nested objects and arrays", () => {
    const out = redact({
      order: { billing: { name: "Priya", payment: { card: "4111", method: "Card" } } },
      attempts: [{ password: "a" }, { password: "b", ok: true }],
    });
    expect(out).toEqual({
      order: { billing: { name: "Priya", payment: { card: REDACTED, method: "Card" } } },
      attempts: [{ password: REDACTED }, { password: REDACTED, ok: true }],
    });
  });

  it("redacts headers and URL query strings", () => {
    const headers = new Headers({ authorization: "Bearer abc", "user-agent": "UA" });
    expect(redact({ headers })).toEqual({ headers: { authorization: REDACTED, "user-agent": "UA" } });
    expect(redact(new URL("https://axiomatic.example/orders/AX-1?t=secret-token"))).toBe(
      "https://axiomatic.example/orders/AX-1?[redacted]",
    );
  });

  it("redacts query strings, fragments and credentials in URL strings", () => {
    const presigned =
      "https://axiomatic-installers.s3.ap-south-1.amazonaws.com/med/v4.2.1/setup.exe" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE&X-Amz-Expires=600&X-Amz-Signature=SECRETSIG";
    const out = redact({
      url: presigned,
      link: "https://axiomatic.example/orders/AX-10312?t=SECRETSIG",
      note: "Guest opened https://axiomatic.example/orders/AX-10312?t=SECRETSIG#key from email",
      request: "GET /orders/AX-10312?t=SECRETSIG 200",
      target: "postgresql://axiomatic:S3cretPass@db.internal:5432/axiomatic?schema=public",
      odd: "redis://:p@ss@cache:6379/0",
      plain: "https://axiomatic.example/software/medical-store-billing",
    }) as Record<string, string>;
    expect(out.url).toBe("https://axiomatic-installers.s3.ap-south-1.amazonaws.com/med/v4.2.1/setup.exe?[redacted]");
    expect(out.link).toBe("https://axiomatic.example/orders/AX-10312?[redacted]");
    expect(out.note).toBe("Guest opened https://axiomatic.example/orders/AX-10312?[redacted] from email");
    expect(out.request).toBe("GET /orders/AX-10312?[redacted] 200");
    expect(out.target).toBe("postgresql://[redacted]@db.internal:5432/axiomatic?[redacted]");
    expect(out.odd).toBe("redis://[redacted]@cache:6379/0");
    expect(out.plain).toBe("https://axiomatic.example/software/medical-store-billing");
    expect(JSON.stringify(out)).not.toMatch(/SECRETSIG|S3cretPass|p@ss|AKIAEXAMPLE/);
  });

  it("redacts NextURL (req.nextUrl), whose toJSON returns the full href", () => {
    const req = new NextRequest("https://axiomatic.example/orders/AX-10312?t=SECRETSIG");
    expect(redact({ nextUrl: req.nextUrl })).toEqual({ nextUrl: "https://axiomatic.example/orders/AX-10312?[redacted]" });
    expect(redact({ params: req.nextUrl.searchParams })).toEqual({ params: REDACTED });
    expect(JSON.stringify(redact(new Error(`fetch failed: ${req.url}`)))).not.toContain("SECRETSIG");
  });
});

describe("redact: key-shaped strings", () => {
  it("masks license keys inside any string value", () => {
    const out = redact({ note: `Customer pasted ${KEY} in the ticket`, list: [`key ${KEY.toLowerCase()}`] }) as {
      note: string;
      list: string[];
    };
    expect(out.note).not.toContain(KEY);
    expect(out.note).toContain("K8NM");
    expect(out.note.startsWith("Customer pasted MED-")).toBe(true);
    expect(out.list[0]).not.toContain(KEY.toLowerCase());
  });

  it("leaves ordinary ids alone", () => {
    expect(redact("LIC-24200 AX-10312 T-3019")).toBe("LIC-24200 AX-10312 T-3019");
  });
});

describe("redact: values", () => {
  it("serialises dates, bigints, buffers and circular references safely", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(
      redact({ at: new Date("2026-10-06T00:00:00.000Z"), size: BigInt(160), blob: Buffer.from("abc"), circular }),
    ).toEqual({
      at: "2026-10-06T00:00:00.000Z",
      size: "160",
      blob: "[binary 3 bytes]",
      circular: { name: "loop", self: "[circular]" },
    });
  });

  it("serialises errors with a masked message and keeps the stack outside production", () => {
    const err = Object.assign(new Error(`Key ${KEY} rejected`), { code: "P2002", token: "abc" });
    const out = redact(err) as Record<string, unknown>;
    expect(out.name).toBe("Error");
    expect(out.message).not.toContain(KEY);
    expect(out.errorCode).toBe("P2002");
    expect(out.token).toBe(REDACTED);
    expect(typeof out.stack).toBe("string");
    expect(String(out.stack)).not.toContain(KEY);
  });

  it("drops stacks in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const out = redact(new Error("boom", { cause: new Error("inner") })) as Record<string, unknown>;
    expect(out.stack).toBeUndefined();
    expect(out.cause).toEqual({ name: "Error", message: "inner" });
  });
});

describe("log", () => {
  it("writes one redacted JSON line per call", () => {
    const lines = capture();
    log.warn("signin_failed", { email: "priya@sharmamedicals.example", password: "nope", detail: `typed ${KEY}` });
    expect(lines).toHaveLength(1);
    const [first] = lines;
    expect(first?.level).toBe("warn");
    expect(first?.data).toMatchObject({ level: "warn", event: "signin_failed", password: REDACTED });
    expect(typeof first?.data.time).toBe("string");
    expect(JSON.stringify(first?.data)).not.toContain(KEY);
  });

  it("does not let fields overwrite the envelope", () => {
    const lines = capture();
    log.info("order_paid", { level: "error", event: "spoofed", orderId: "AX-10312" });
    expect(lines[0]?.data).toMatchObject({ level: "info", event: "order_paid", orderId: "AX-10312" });
  });

  it("routes levels to the sink and never throws", () => {
    const lines = capture();
    log.info("a");
    log.error("c", { error: new Error("x") });
    expect(lines.map((l) => l.level)).toEqual(["info", "error"]);
    setLogSink(() => {
      throw new Error("sink down");
    });
    expect(() => log.error("still fine")).not.toThrow();
  });
});
