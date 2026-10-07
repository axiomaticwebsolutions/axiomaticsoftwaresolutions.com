import { redirect } from "next/navigation";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ApiError,
  clientIp,
  clientIpFromHeaders,
  errorResponse,
  errors,
  ipBucket,
  ipPrefix,
  json,
  parseJsonBody,
  route,
  SERVICE_UNAVAILABLE_MESSAGE,
  type ErrorBody,
} from "@/lib/http";
import { Prisma } from "@/generated/prisma/client";
import type * as EnvModule from "@/lib/env";
import { setLogSink } from "@/lib/log";

// clientIp() reads TRUSTED_PROXY_HOPS through getEnv(); the rest of lib/env stays real.
const envStub = vi.hoisted(() => ({ hops: 0 }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  getEnv: () => ({ TRUSTED_PROXY_HOPS: envStub.hops }) as unknown as EnvModule.Env,
}));

afterEach(() => setLogSink(null));

async function bodyOf(res: Response): Promise<ErrorBody> {
  return (await res.json()) as ErrorBody;
}

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("errorResponse", () => {
  it("maps ApiError helpers to the envelope with status and no-store", async () => {
    const res = errorResponse(errors.notFound("License"));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(res)).toEqual({ error: { code: "not_found", message: "License not found." } });

    const unauthorized = errorResponse(errors.unauthorized());
    expect(unauthorized.status).toBe(401);
    expect(await bodyOf(unauthorized)).toEqual({ error: { code: "unauthorized", message: "Sign in to continue." } });

    const conflict = errorResponse(errors.conflict("trial_used", "You already used the trial.", { productId: "medical-billing" }));
    expect(conflict.status).toBe(409);
    expect(await bodyOf(conflict)).toEqual({
      error: { code: "trial_used", message: "You already used the trial.", productId: "medical-billing" },
    });
    expect(errorResponse(errors.forbidden()).status).toBe(403);
  });

  it("adds Retry-After for rate limits", async () => {
    const res = errorResponse(errors.rateLimited(900));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(await bodyOf(res)).toEqual({
      error: { code: "too_many_attempts", message: "Too many attempts. Try again in 15 minutes.", retryAfterSec: 900 },
    });
    expect((await bodyOf(errorResponse(errors.rateLimited(20)))).error.message).toBe("Too many attempts. Try again in a minute.");
  });

  it("returns field errors for validation failures", async () => {
    const res = errorResponse(errors.validation({ email: "Enter a valid email address." }));
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toEqual({
      error: {
        code: "validation_failed",
        message: "Please fix the highlighted fields.",
        fieldErrors: { email: ["Enter a valid email address."] },
        formErrors: [],
      },
    });
  });

  it("maps a thrown ZodError to 422 with dotted field paths", async () => {
    const schema = z.strictObject({ billing: z.strictObject({ pin: z.string().regex(/^[0-9]{6}$/, "PIN code should be 6 digits.") }) });
    const parsed = schema.safeParse({ billing: { pin: "12" } });
    if (parsed.success) throw new Error("expected failure");
    const res = errorResponse(parsed.error);
    expect(res.status).toBe(422);
    expect((await bodyOf(res)).error.fieldErrors).toEqual({ "billing.pin": ["PIN code should be 6 digits."] });
  });

  it("hides unknown errors behind a logged 500", async () => {
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    const res = errorResponse(new Error("db password=hunter2 leaked"), { method: "POST", path: "/api/x" });
    expect(res.status).toBe(500);
    const body = await bodyOf(res);
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "error", event: "unhandled_error", path: "/api/x" });
  });
});

describe("errorResponse: database unavailable", () => {
  it("answers 503 unavailable with Retry-After for pool waits and statement timeouts, logging once per 10 s", async () => {
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-07T03:00:00Z"));
      const pool = errorResponse(new Error("timeout exceeded when trying to connect"), { method: "POST", path: "/api/v1/licenses/validate" });
      expect(pool.status).toBe(503);
      expect(pool.headers.get("retry-after")).toBe("5");
      expect(pool.headers.get("cache-control")).toBe("no-store");
      expect(await bodyOf(pool)).toEqual({ error: { code: "unavailable", message: SERVICE_UNAVAILABLE_MESSAGE, retryAfterSec: 5 } });

      const timeout = new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `57014`.", {
        code: "P2010",
        clientVersion: "test",
        meta: { driverAdapterError: { cause: { kind: "postgres", originalCode: "57014" } } },
      });
      expect(errorResponse(timeout, { path: "/api/account/licenses" }).status).toBe(503);
      expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
        expect.objectContaining({ level: "warn", event: "database_unavailable", reason: "pool_timeout", path: "/api/v1/licenses/validate" }),
      ]);

      vi.setSystemTime(new Date("2026-10-07T03:00:11Z"));
      errorResponse(timeout, { path: "/api/account/licenses" });
      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ event: "database_unavailable", reason: "statement_timeout", suppressedSinceLast: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps other database errors (deadlock, unique violation) as a logged 500", () => {
    setLogSink(() => undefined);
    const deadlock = new Prisma.PrismaClientKnownRequestError("deadlock", { code: "P2034", clientVersion: "test" });
    expect(errorResponse(deadlock).status).toBe(500);
  });
});

describe("json", () => {
  it("defaults to no-store but respects an explicit Cache-Control", async () => {
    expect(json({ ok: true }).headers.get("cache-control")).toBe("no-store");
    const cached = json({ ok: true }, { headers: { "Cache-Control": "public, max-age=60" } });
    expect(cached.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await cached.json()).toEqual({ ok: true });
  });
});

describe("parseJsonBody", () => {
  const schema = z.strictObject({ email: z.string().email("Enter a valid email address."), qty: z.number().int().optional() });

  async function failure(p: Promise<unknown>): Promise<ApiError> {
    try {
      await p;
    } catch (e) {
      if (e instanceof ApiError) return e;
      throw e;
    }
    throw new Error("expected an ApiError");
  }

  it("parses a valid body (charset parameter allowed)", async () => {
    const req = jsonRequest(JSON.stringify({ email: "a@b.example", qty: 2 }), { "content-type": "application/json; charset=utf-8" });
    await expect(parseJsonBody(req, schema)).resolves.toEqual({ email: "a@b.example", qty: 2 });
  });

  it("rejects non-JSON content types with 415", async () => {
    const req = new Request("http://localhost/api/test", { method: "POST", body: "email=a", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await failure(parseJsonBody(req, schema))).status).toBe(415);
  });

  it("rejects oversized bodies with 413, by header and while streaming", async () => {
    const declared = jsonRequest(JSON.stringify({ email: "a@b.example" }), { "content-length": "999999" });
    expect((await failure(parseJsonBody(declared, schema))).status).toBe(413);
    const big = jsonRequest(JSON.stringify({ email: "a@b.example", pad: "x".repeat(2000) }));
    const err = await failure(parseJsonBody(big, schema, { maxBytes: 1024 }));
    expect(err.status).toBe(413);
    expect(err.code).toBe("payload_too_large");
  });

  it("rejects invalid or empty JSON with 400 invalid_json", async () => {
    expect((await failure(parseJsonBody(jsonRequest("{not json"), schema))).code).toBe("invalid_json");
    expect((await failure(parseJsonBody(jsonRequest(""), schema))).status).toBe(400);
  });

  it("rejects schema failures and unknown keys with 422", async () => {
    const err = await failure(parseJsonBody(jsonRequest(JSON.stringify({ email: "nope", role: "OWNER" })), schema));
    expect(err.status).toBe(422);
    expect(err.code).toBe("validation_failed");
    expect(err.details?.fieldErrors).toEqual({ email: ["Enter a valid email address."], role: ["Unknown field."] });
  });
});

describe("route", () => {
  const req = () => new NextRequest("http://localhost/api/account/licenses?q=1", { method: "GET" });

  it("passes successful responses through", async () => {
    const handler = route(async () => json({ ok: true }));
    const res = await handler(req(), {});
    expect(res.status).toBe(200);
  });

  it("maps thrown ApiErrors and unknown errors", async () => {
    setLogSink(() => undefined);
    expect((await route(() => Promise.reject(errors.forbidden()))(req(), {})).status).toBe(403);
    const crashed = await route(() => {
      throw new Error("boom");
    })(req(), {});
    expect(crashed.status).toBe(500);
  });

  it("re-throws Next.js control flow such as redirect()", async () => {
    const handler = route(() => redirect("/sign-in"));
    await expect(handler(req(), {})).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
  });
});

describe("clientIpFromHeaders", () => {
  const h = (values: Record<string, string>) => new Headers(values);

  it("trusts nothing with 0 proxies: forged X-Forwarded-For and X-Real-IP are ignored", () => {
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), 0)).toBeNull();
    expect(clientIpFromHeaders(h({ "x-real-ip": "6.6.6.6" }), 0)).toBeNull();
    expect(clientIpFromHeaders(h({}), 0)).toBeNull();
  });

  it("takes the entry the outermost trusted proxy appended, never a client-supplied one", () => {
    // ALB appends the peer address: everything left of it came from the client.
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 103.21.44.17" }), 1)).toBe("103.21.44.17");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": " 103.21.44.17 " }), 1)).toBe("103.21.44.17");
    // CloudFront appends the client, then ALB appends CloudFront's edge address.
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 103.21.44.17, 130.176.1.2" }), 2)).toBe("103.21.44.17");
    // Rotating the forged part never changes the result.
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "7.7.7.7, 8.8.8.8, 103.21.44.17" }), 1)).toBe("103.21.44.17");
  });

  it("ignores X-Real-IP and returns null for garbage in the trusted position", () => {
    expect(clientIpFromHeaders(h({ "x-real-ip": "49.36.1.2" }), 1)).toBeNull();
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "103.21.44.17, garbage", "x-real-ip": "49.36.1.2" }), 1)).toBeNull();
  });

  it("falls back to the left-most entry when a hop was skipped", () => {
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "103.21.44.17" }), 2)).toBe("103.21.44.17");
  });

  it("normalises ports, brackets and IPv4-mapped IPv6", () => {
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "103.21.44.17:5123" }), 1)).toBe("103.21.44.17");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "[2001:DB8::1]:443" }), 1)).toBe("2001:db8::1");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "::ffff:103.21.44.17" }), 1)).toBe("103.21.44.17");
  });

  it("rejects a bad hop count", () => {
    expect(() => clientIpFromHeaders(h({}), -1)).toThrow(RangeError);
    expect(() => clientIpFromHeaders(h({}), 1.5)).toThrow(RangeError);
  });
});

describe("clientIp", () => {
  afterEach(() => {
    envStub.hops = 0;
  });

  it("applies TRUSTED_PROXY_HOPS from the environment", () => {
    const req = { headers: new Headers({ "x-forwarded-for": "6.6.6.6, 103.21.44.17" }) };
    expect(clientIp(req)).toBeNull();
    envStub.hops = 1;
    expect(clientIp(req)).toBe("103.21.44.17");
    expect(ipPrefix(clientIp(req))).toBe("103.21.44.x");
  });
});

describe("ipPrefix / ipBucket", () => {
  it("truncates IPv4 to /24 and IPv6 to /48 for display", () => {
    expect(ipPrefix("103.21.44.17")).toBe("103.21.44.x");
    expect(ipPrefix("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:db8:85a3::/48");
    expect(ipPrefix("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(ipPrefix("::ffff:1.2.3.4")).toBe("1.2.3.x");
    expect(ipPrefix("not an ip")).toBeNull();
    expect(ipPrefix(null)).toBeNull();
  });

  it("buckets IPv6 by /64 for rate limits", () => {
    expect(ipBucket("2001:db8:85a3:1:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:85a3:1::/64");
    expect(ipBucket("2001:db8:85a3:1::9")).toBe("2001:db8:85a3:1::/64");
    expect(ipBucket("103.21.44.17")).toBe("103.21.44.17");
    expect(ipBucket(null)).toBe("unknown");
  });
});
