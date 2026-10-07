/**
 * POST /validate and /deactivate services (lib/licensing/activation.ts) against the test database: token refresh,
 * token binding and tampering, the 30-day refresh window, deactivated devices, license states, latestEligibleVersion,
 * the hot-path budget (one indexed read, a write at most once per 12 h, no LicenseEvent rows) and device-initiated
 * deactivation (frees a slot, never touches the yearly self-service counter).
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { peek, RATE_LIMITS, setRateLimitStore } from "@/lib/auth/rate-limit";
import { addDays, DAY_MS } from "@/lib/dates";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";
import {
  activateLicense,
  clearReleaseCache,
  deactivateFromDevice,
  DEVICE_ACTOR,
  validateActivation,
  type ActivationContext,
} from "@/lib/licensing/activation";
import { signActivationToken, verifyActivationToken } from "@/lib/licensing/activation-token";
import { revokeOrderLicenses } from "@/lib/licensing/fulfil";
import { memoryRateLimitStore } from "../support/memory-rate-limit-store";
import {
  activationInput,
  issue,
  newAccount,
  newFingerprint,
  nextIp,
  paidOrderWithLicense,
  rejection,
  seedActivationCatalog,
  type ActivationCatalog,
} from "./activation-fixtures";

const HOUR_MS = 3_600_000;
let cat: ActivationCatalog;
const T0 = new Date();

beforeAll(async () => {
  cat = await seedActivationCatalog();
  const pid = cat.product.id;
  const release = (version: string, releasedAt: Date | null, extra: { status?: "PUBLISHED" | "DRAFT"; channel?: string } = {}) =>
    db.release.create({ data: { productId: pid, version, releasedAt, status: extra.status ?? "PUBLISHED", channel: extra.channel ?? "stable", notes: [] } });
  await release("1.0.0", addDays(T0, -500));
  await release("1.5.0", addDays(T0, -100));
  await release("2.0.0", addDays(T0, -10));
  await release("2.1.0-beta.1", addDays(T0, -5), { channel: "beta" });
  await release("2.2.0", addDays(T0, 5));
  await release("3.0.0", null, { status: "DRAFT" });
  clearReleaseCache();
});

afterEach(() => {
  setRateLimitStore(null);
});

const ctx = (extra: Partial<ActivationContext> = {}): ActivationContext => ({ appId: cat.product.code, ip: nextIp(), ...extra });

/** Activates a fresh device on a new license of `plan`; returns what the app would keep. */
async function activated(plan = cat.plans.annual, opts: { accountId?: string | null; at?: Date; now?: Date } = {}) {
  const { license, key } = await issue(cat, plan, { accountId: opts.accountId, at: opts.at });
  const fp = newFingerprint();
  const res = await activateLicense(activationInput(key, fp), ctx({ now: opts.now }));
  return { license, key, fp, token: res.activationToken };
}

const validate = (token: string, fp: string, extra: Partial<ActivationContext> & { appVersion?: string } = {}) =>
  validateActivation({ activationToken: token, deviceFingerprint: fp, appVersion: extra.appVersion ?? "4.2.1" }, ctx(extra));

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code });
  return error as ApiError;
}

/** Wraps a Prisma client and records every method called on it or its model delegates ("deviceActivation.updateMany"). */
function countingDb(base: PrismaClient): { client: PrismaClient; calls: string[] } {
  const calls: string[] = [];
  const wrap = <T extends object>(target: T, prefix: string): T =>
    new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop) as unknown;
        if (typeof prop !== "string") return value;
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            calls.push(`${prefix}${prop}`);
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (value !== null && typeof value === "object" && !prop.startsWith("$") && !prop.startsWith("_")) {
          return wrap(value, `${prop}.`);
        }
        return value;
      },
    });
  return { client: wrap(base, ""), calls };
}

describe("validateActivation", () => {
  it("confirms the license and returns a fresh token, nextCheckBefore and the latest eligible version", async () => {
    const { license, fp, token } = await activated();
    const now = new Date(Date.now() + 60_000);
    const res = await validate(token, fp, { now });

    const grace = getEnv().LICENSE_OFFLINE_GRACE_DAYS;
    expect(res).toEqual({
      valid: true,
      status: "active",
      expiresAt: license.expiresAt?.toISOString(),
      updatesUntil: license.updatesUntil.toISOString(),
      latestEligibleVersion: "2.0.0",
      nextCheckBefore: new Date(Math.floor(now.getTime() / 1000) * 1000 + grace * DAY_MS).toISOString(),
      activationToken: expect.any(String),
    });
    expect(res.activationToken).not.toBe(token);
    const fresh = await verifyActivationToken(res.activationToken, { now });
    expect(fresh.claims).toEqual({ lic: license.id, fp, prod: cat.product.code });
    expect(fresh.expiresAt.toISOString()).toBe(res.nextCheckBefore);
  });

  it("offers a one-time license only releases from its updates window", async () => {
    const { fp, token, license } = await activated(cat.plans.oneTime, { at: addDays(T0, -400) });
    expect(license.expiresAt).toBeNull();
    const res = await validate(token, fp);
    expect(res).toMatchObject({ valid: true, expiresAt: null, latestEligibleVersion: "1.5.0" });
  });

  it("answers latestEligibleVersion null when the license covers no stable release", async () => {
    // Updates ended about 535 days ago, before the oldest release (500 days ago).
    const { fp, token } = await activated(cat.plans.oneTime, { at: addDays(T0, -900) });
    expect(await validate(token, fp)).toMatchObject({ valid: true, latestEligibleVersion: null });
  });

  it("never lets nextCheckBefore (the token exp) pass the license end", async () => {
    const { license, fp, token } = await activated();
    const end = new Date(Date.now() + DAY_MS + 1_234);
    await db.license.update({ where: { id: license.id }, data: { expiresAt: end } });
    const res = await validate(token, fp);
    expect(res.nextCheckBefore).toBe(new Date(Math.floor(end.getTime() / 1000) * 1000).toISOString());
    expect((await verifyActivationToken(res.activationToken)).expiresAt.toISOString()).toBe(res.nextCheckBefore);
    // Past the end the app must check again and gets license_expired instead of a fresh token.
    await expectApiError(validate(res.activationToken, fp, { now: new Date(end.getTime() + 1_000) }), 403, "license_expired");

    // A trial activated on its last day: the activation token ends with the trial, not 7 days later.
    const trial = await issue(cat, cat.plans.trial, { status: "TRIAL", at: new Date(Date.now() - 14.5 * DAY_MS) });
    const trialEnd = trial.license.expiresAt?.getTime() ?? 0;
    const act = await activateLicense(activationInput(trial.key, newFingerprint()), ctx());
    expect((await verifyActivationToken(act.activationToken)).expiresAt.getTime()).toBe(Math.floor(trialEnd / 1000) * 1000);
  });

  it("reports trials as status trial", async () => {
    const { fp, token } = await activated(cat.plans.trial);
    expect((await validate(token, fp)).status).toBe("trial");
  });

  it("rejects a token presented with another fingerprint", async () => {
    const { token } = await activated();
    await expectApiError(validate(token, newFingerprint()), 401, "fingerprint_mismatch");
  });

  it("rejects tampered tokens and tokens signed with another key", async () => {
    const { fp, token, license } = await activated();
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const flipped = `${signature.slice(0, 10)}${signature[10] === "A" ? "B" : "A"}${signature.slice(11)}`;
    await expectApiError(validate(`${header}.${payload}.${flipped}`, fp), 401, "invalid_token");

    const forgedClaims = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), lic: "LIC-1" })).toString("base64url");
    await expectApiError(validate(`${header}.${forgedClaims}.${signature}`, fp), 401, "invalid_token");

    const other = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const { token: foreign } = await signActivationToken({ lic: license.id, fp, prod: cat.product.code }, { privateKeyPem: other.privateKey });
    await expectApiError(validate(foreign, fp), 401, "invalid_token");
    await expectApiError(validate("not-a-token", fp), 401, "invalid_token");
  });

  it("refreshes tokens up to 30 days past expiry and refuses older ones", async () => {
    const { fp, token } = await activated();
    const exp = (await verifyActivationToken(token)).expiresAt.getTime();
    const late = await validate(token, fp, { now: new Date(exp + 29 * DAY_MS) });
    expect(late.valid).toBe(true);
    await expectApiError(validate(token, fp, { now: new Date(exp + 30 * DAY_MS + 1000) }), 401, "token_expired");
  });

  it("refuses a device deactivated from the portal or by the device", async () => {
    const a = await activated();
    await db.deviceActivation.updateMany({ where: { licenseId: a.license.id }, data: { deactivatedAt: new Date(), deactivatedBy: "customer" } });
    await expectApiError(validate(a.token, a.fp), 403, "device_deactivated");

    const b = await activated();
    await deactivateFromDevice({ activationToken: b.token, deviceFingerprint: b.fp }, ctx());
    await expectApiError(validate(b.token, b.fp), 403, "device_deactivated");
  });

  it("fails with license_revoked after a refund, and with license_suspended / license_expired", async () => {
    const accountId = await newAccount();
    const order = await paidOrderWithLicense(cat.plans.annual, accountId);
    const fp = newFingerprint();
    const { activationToken } = await activateLicense(activationInput(order.key, fp), ctx());
    await db.$transaction((tx) => revokeOrderLicenses(tx, order.orderId, { reason: "Refunded", actor: "System", at: new Date() }));
    await expectApiError(validate(activationToken, fp), 403, "license_revoked");

    const s = await activated();
    await db.license.update({ where: { id: s.license.id }, data: { status: "SUSPENDED" } });
    await expectApiError(validate(s.token, s.fp), 403, "license_suspended");

    const e = await activated();
    await db.license.update({ where: { id: e.license.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expectApiError(validate(e.token, e.fp), 403, "license_expired");
  });

  it("refuses a token used by another product's app with 422 wrong_product", async () => {
    const { fp, token } = await activated();
    await expectApiError(validate(token, fp, { appId: cat.other.code }), 422, "wrong_product");
  });

  it("stays within the hot-path budget: one read, a presence write at most once per 12 h, no events", async () => {
    setRateLimitStore(memoryRateLimitStore()); // keeps rate-limit writes out of the database count
    const { license, fp, token } = await activated(cat.plans.annual, { now: T0 });
    const device = await db.deviceActivation.findFirstOrThrow({ where: { licenseId: license.id } });
    const eventsBefore = await db.licenseEvent.count({ where: { licenseId: license.id } });
    await validate(token, fp, { now: new Date(T0.getTime() + 60_000) }); // warms the release cache

    const { client, calls } = countingDb(db);
    const at = (hours: number) => new Date(T0.getTime() + hours * HOUR_MS);
    const run = async (hours: number, appVersion: string) => {
      calls.length = 0;
      await validate(token, fp, { now: at(hours), appVersion, db: client });
      return [...calls];
    };

    expect(await run(1, "4.2.2")).toEqual(["$queryRaw"]);
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: device.id } })).lastSeenAt).toEqual(device.lastSeenAt);

    expect(await run(13, "4.2.2")).toEqual(["$queryRaw", "deviceActivation.updateMany"]);
    const touched = await db.deviceActivation.findUniqueOrThrow({ where: { id: device.id } });
    expect(touched).toMatchObject({ lastSeenAt: at(13), appVersion: "4.2.2" });

    // Two calls within 12 h of the write: no further writes.
    expect(await run(14, "4.2.3")).toEqual(["$queryRaw"]);
    expect(await run(24.5, "4.2.3")).toEqual(["$queryRaw"]);
    expect(await db.deviceActivation.findUniqueOrThrow({ where: { id: device.id } })).toMatchObject({ lastSeenAt: at(13), appVersion: "4.2.2" });

    expect(await run(25, "4.2.3")).toEqual(["$queryRaw", "deviceActivation.updateMany"]);
    expect(await db.licenseEvent.count({ where: { licenseId: license.id } })).toBe(eventsBefore);
  });

  it("limits validations per license (30 / min) with Retry-After", async () => {
    const { fp, token } = await activated();
    const now = new Date();
    for (let i = 0; i < 30; i += 1) await validate(token, fp, { now });
    const limited = await expectApiError(validate(token, fp, { now }), 429, "too_many_attempts");
    expect(Number(limited.headers?.["Retry-After"])).toBeGreaterThan(0);
  });

  it("gives back the per-IP slot when the per-license limit refuses (validate and deactivate)", async () => {
    setRateLimitStore(memoryRateLimitStore());
    const { fp, token } = await activated();
    const ip = nextIp();
    const now = new Date();
    for (let i = 0; i < 30; i += 1) await validate(token, fp, { ip, now });
    for (let i = 0; i < 5; i += 1) await expectApiError(validate(token, fp, { ip, now }), 429, "too_many_attempts");
    expect((await peek(db, RATE_LIMITS.validateIp(ip), now)).count).toBe(30);

    const body = { activationToken: token, deviceFingerprint: fp };
    for (let i = 0; i < 30; i += 1) await deactivateFromDevice(body, ctx({ ip, now }));
    await expectApiError(deactivateFromDevice(body, ctx({ ip, now })), 429, "too_many_attempts");
    expect((await peek(db, RATE_LIMITS.deactivateIp(ip), now)).count).toBe(30);
  });

  it("limits validations per client IP (60 / min) before checking the token", async () => {
    const ip = nextIp();
    const now = new Date();
    for (let i = 0; i < 60; i += 1) await expectApiError(validate("not-a-token", newFingerprint(), { ip, now }), 401, "invalid_token");
    await expectApiError(validate("not-a-token", newFingerprint(), { ip, now }), 429, "too_many_attempts");
  });
});

describe("deactivateFromDevice", () => {
  it("frees the slot without touching the yearly self-service counter, and logs it", async () => {
    const accountId = await newAccount();
    const { license, key } = await issue(cat, cat.plans.annual, { accountId });
    const fp = newFingerprint();
    const first = await activateLicense(activationInput(key, fp, { deviceName: "Old counter PC" }), ctx());
    await expectApiError(activateLicense(activationInput(key, newFingerprint()), ctx()), 409, "activation_limit_reached");

    const res = await deactivateFromDevice({ activationToken: first.activationToken, deviceFingerprint: fp }, ctx());
    expect(res).toEqual({ status: "deactivated", devicesUsed: 0 });

    const device = await db.deviceActivation.findFirstOrThrow({ where: { licenseId: license.id, fingerprint: fp } });
    expect(device.deactivatedAt).not.toBeNull();
    expect(device.deactivatedBy).toBe("device");
    expect(await db.license.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({
      selfServiceResets: license.selfServiceResets,
      resetsYear: license.resetsYear,
    });
    expect(await db.licenseEvent.findMany({ where: { licenseId: license.id, type: "deactivated" } })).toEqual([
      expect.objectContaining({ actor: DEVICE_ACTOR, detail: "Old counter PC" }),
    ]);
    expect(await db.accountActivity.findFirst({ where: { accountId, action: "Deactivated device" } })).toMatchObject({
      actorName: DEVICE_ACTOR,
      target: `${license.id} \u00B7 Old counter PC`,
      kind: "license",
    });

    // The freed slot takes a new computer; repeating the deactivation is harmless.
    expect((await activateLicense(activationInput(key, newFingerprint()), ctx())).status).toBe("activated");
    expect(await deactivateFromDevice({ activationToken: first.activationToken, deviceFingerprint: fp }, ctx())).toEqual({
      status: "already_deactivated",
      devicesUsed: 1,
    });
    expect(await db.licenseEvent.count({ where: { licenseId: license.id, type: "deactivated" } })).toBe(1);
  });

  it("works for a revoked license and an expired token inside the refresh window", async () => {
    const { license, fp, token } = await activated();
    await db.license.update({ where: { id: license.id }, data: { status: "REVOKED", revokedAt: new Date(), revokedReason: "Test" } });
    const exp = (await verifyActivationToken(token)).expiresAt.getTime();
    const res = await deactivateFromDevice({ activationToken: token, deviceFingerprint: fp }, ctx({ now: new Date(exp + DAY_MS) }));
    expect(res).toEqual({ status: "deactivated", devicesUsed: 0 });
  });

  it("refuses another computer's fingerprint, a bad token and another product's app", async () => {
    const { fp, token, license } = await activated();
    await expectApiError(deactivateFromDevice({ activationToken: token, deviceFingerprint: newFingerprint() }, ctx()), 401, "fingerprint_mismatch");
    await expectApiError(deactivateFromDevice({ activationToken: `${token}x`, deviceFingerprint: fp }, ctx()), 401, "invalid_token");
    await expectApiError(deactivateFromDevice({ activationToken: token, deviceFingerprint: fp }, ctx({ appId: cat.other.code })), 422, "wrong_product");
    expect(await db.deviceActivation.count({ where: { licenseId: license.id, deactivatedAt: null } })).toBe(1);
  });
});
