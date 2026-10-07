/**
 * The /api/v1/licenses/* route handlers end to end (header, body parsing, status codes, response bodies and headers)
 * against the test database. TRUSTED_PROXY_HOPS=1 so each request carries its own client IP in X-Forwarded-For.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { revokeOrderLicenses } from "@/lib/licensing/fulfil";
import { issue, newAccount, newFingerprint, nextIp, paidOrderWithLicense, seedActivationCatalog, type ActivationCatalog } from "./activation-fixtures";

process.env.TRUSTED_PROXY_HOPS = "1";
resetEnvCache();

const { POST: activateRoute } = await import("@/app/api/v1/licenses/activate/route");
const { POST: validateRoute } = await import("@/app/api/v1/licenses/validate/route");
const { POST: deactivateRoute } = await import("@/app/api/v1/licenses/deactivate/route");

const BASE = "http://localhost:3000/api/v1/licenses";
let cat: ActivationCatalog;

beforeAll(async () => {
  cat = await seedActivationCatalog();
});

function post(path: string, body: unknown, opts: { appId?: string | null; ip?: string; contentType?: string } = {}): NextRequest {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/json",
    "x-forwarded-for": opts.ip ?? nextIp(),
  };
  if (opts.appId !== null) headers["x-app-id"] = opts.appId ?? cat.product.code;
  return new NextRequest(`${BASE}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

const device = (key: string, fp: string) => ({
  licenseKey: key,
  deviceFingerprint: fp,
  deviceName: "Billing counter PC",
  os: "Windows 11 Pro",
  appVersion: "4.2.1",
});

type Json = Record<string, unknown> & { error?: { code: string; message: string } & Record<string, unknown> };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Json, headers: res.headers });

describe("POST /api/v1/licenses/activate", () => {
  it("activates, answers no-store and the contract body", async () => {
    const { license, key } = await issue(cat, cat.plans.annual);
    const res = await read(await activateRoute(post("/activate", device(key, newFingerprint())), undefined));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual(
      ["activationToken", "deviceLimit", "devicesUsed", "expiresAt", "licenseId", "offlineGraceDays", "plan", "status", "updatesUntil"].sort(),
    );
    expect(res.body).toMatchObject({ status: "activated", licenseId: license.id, plan: "annual", devicesUsed: 1, deviceLimit: 1 });
  });

  it("requires X-App-Id and a strict JSON body", async () => {
    const { key } = await issue(cat, cat.plans.annual);
    const fp = newFingerprint();
    const noApp = await read(await activateRoute(post("/activate", device(key, fp), { appId: null }), undefined));
    expect(noApp).toMatchObject({ status: 400, body: { error: { code: "invalid_app_id" } } });
    expect((await activateRoute(post("/activate", device(key, fp), { appId: "MEDICAL" }), undefined)).status).toBe(400);

    const extra = await read(await activateRoute(post("/activate", { ...device(key, fp), plan: "annual" }), undefined));
    expect(extra.status).toBe(422);
    expect(extra.body.error).toMatchObject({ code: "validation_failed", fieldErrors: { plan: ["Unknown field."] } });

    const badFp = await read(await activateRoute(post("/activate", device(key, "abc")), undefined));
    expect(badFp.status).toBe(422);
    expect(badFp.body.error?.fieldErrors).toHaveProperty("deviceFingerprint");

    const form = post("/activate", "licenseKey=x", { contentType: "application/x-www-form-urlencoded" });
    expect((await activateRoute(form, undefined)).status).toBe(415);
    expect((await activateRoute(post("/activate", "{"), undefined)).status).toBe(400);
    const huge = post("/activate", { ...device(key, fp), deviceName: "x".repeat(5000) });
    expect((await activateRoute(huge, undefined)).status).toBe(413);
  });

  it("answers 409 with the slot details in the error envelope", async () => {
    const { license, key } = await issue(cat, cat.plans.annual);
    await activateRoute(post("/activate", device(key, newFingerprint())), undefined);
    const res = await read(await activateRoute(post("/activate", device(key, newFingerprint())), undefined));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: "activation_limit_reached",
        message: expect.stringContaining("device slot"),
        devicesUsed: 1,
        deviceLimit: 1,
        manageUrl: expect.stringMatching(new RegExp(`/account/licenses/${license.id}$`)),
      },
    });
  });

  it("answers 404 for malformed keys and 429 with Retry-After once the IP is over its limit", async () => {
    const ip = nextIp();
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) last = await activateRoute(post("/activate", device(`ZZZ-${i}`, newFingerprint()), { ip }), undefined);
    const res = await read(last as Response);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.body.error?.code).toBe("too_many_attempts");
    const other = await read(await activateRoute(post("/activate", device("ZZZ-1", newFingerprint())), undefined));
    expect(other).toMatchObject({ status: 404, body: { error: { code: "invalid_key" } } });
  });
});

describe("POST /api/v1/licenses/validate and /deactivate", () => {
  const validateBody = (token: string, fp: string) => ({ activationToken: token, deviceFingerprint: fp, appVersion: "4.2.1" });

  it("validates, then reports a revoked license as valid:false with the error envelope", async () => {
    const accountId = await newAccount();
    const order = await paidOrderWithLicense(cat.plans.annual, accountId);
    const fp = newFingerprint();
    const activated = await read(await activateRoute(post("/activate", device(order.key, fp)), undefined));
    const token = activated.body.activationToken as string;

    const ok = await read(await validateRoute(post("/validate", validateBody(token, fp)), undefined));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.body).toMatchObject({ valid: true, status: "active", activationToken: expect.any(String), nextCheckBefore: expect.any(String) });

    await db.$transaction((tx) => revokeOrderLicenses(tx, order.orderId, { reason: "Refunded", actor: "System", at: new Date() }));
    const revoked = await read(await validateRoute(post("/validate", validateBody(token, fp)), undefined));
    expect(revoked.status).toBe(403);
    expect(revoked.body).toEqual({
      valid: false,
      reason: "license_revoked",
      error: { code: "license_revoked", message: expect.any(String) },
    });
    const again = await read(await activateRoute(post("/activate", device(order.key, newFingerprint())), undefined));
    expect(again).toMatchObject({ status: 403, body: { error: { code: "license_revoked" } } });
  });

  it("keeps bad requests out of valid:false and reports bad tokens with it", async () => {
    const fp = newFingerprint();
    const missing = await read(await validateRoute(post("/validate", { activationToken: "x", deviceFingerprint: fp }), undefined));
    expect(missing.status).toBe(422);
    expect(missing.body).not.toHaveProperty("valid");
    const noApp = await read(await validateRoute(post("/validate", validateBody("x", fp), { appId: null }), undefined));
    expect(noApp.status).toBe(400);
    expect(noApp.body).not.toHaveProperty("valid");
    const badToken = await read(await validateRoute(post("/validate", validateBody("x", fp)), undefined));
    expect(badToken).toMatchObject({ status: 401, body: { valid: false, reason: "invalid_token", error: { code: "invalid_token" } } });
  });

  it("answers 429 with Retry-After and without valid:false when the IP is over its limit", async () => {
    const ip = nextIp();
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) last = await validateRoute(post("/validate", validateBody("x", newFingerprint()), { ip }), undefined);
    const res = await read(last as Response);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.body).not.toHaveProperty("valid");
  });

  it("deactivates from the device", async () => {
    const { key } = await issue(cat, cat.plans.annual);
    const fp = newFingerprint();
    const activated = await read(await activateRoute(post("/activate", device(key, fp)), undefined));
    const body = { activationToken: activated.body.activationToken, deviceFingerprint: fp };
    const res = await read(await deactivateRoute(post("/deactivate", body), undefined));
    expect(res).toMatchObject({ status: 200, body: { status: "deactivated", devicesUsed: 0 } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
