/**
 * POST /activate service (lib/licensing/activation.ts) against the test database: test-plan "License issuance &
 * activation" (success, already_active, limit, expired, suspended, revoked after a refund, wrong product, unknown and
 * malformed keys, concurrency, rate limits by key hash and by IP).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { addDays, DAY_MS } from "@/lib/dates";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";
import {
  ACTIVATION_MESSAGES,
  activateLicense,
  activationChurnLimit,
  deactivateFromDevice,
  DEVICE_ACTOR,
} from "@/lib/licensing/activation";
import { verifyActivationToken } from "@/lib/licensing/activation-token";
import { revokeOrderLicenses } from "@/lib/licensing/fulfil";
import { generateLicenseKey } from "@/lib/licensing/keys";
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

let cat: ActivationCatalog;

beforeAll(async () => {
  cat = await seedActivationCatalog();
});

const activate = (key: string, fingerprint: string, opts: { appId?: string; ip?: string; now?: Date; name?: string } = {}) =>
  activateLicense(activationInput(key, fingerprint, opts.name ? { deviceName: opts.name } : {}), {
    appId: opts.appId ?? cat.product.code,
    ip: opts.ip ?? nextIp(),
    now: opts.now,
  });

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code });
  return error as ApiError;
}

const activeDevices = (licenseId: string) => db.deviceActivation.count({ where: { licenseId, deactivatedAt: null } });

describe("activateLicense", () => {
  it("activates a device and returns the contract response with a verifiable token", async () => {
    const accountId = await newAccount();
    const { license, key } = await issue(cat, cat.plans.annual, { accountId });
    const fp = newFingerprint();

    const res = await activate(key, fp, { name: "Billing counter PC" });

    expect(res).toEqual({
      status: "activated",
      licenseId: license.id,
      activationToken: expect.any(String),
      plan: "annual",
      expiresAt: license.expiresAt?.toISOString(),
      updatesUntil: license.updatesUntil.toISOString(),
      deviceLimit: 1,
      devicesUsed: 1,
      offlineGraceDays: getEnv().LICENSE_OFFLINE_GRACE_DAYS,
    });
    const verified = await verifyActivationToken(res.activationToken);
    expect(verified.claims).toEqual({ lic: license.id, fp, prod: cat.product.code });
    expect(verified.expiresAt.getTime() - Date.now()).toBeGreaterThan((getEnv().LICENSE_OFFLINE_GRACE_DAYS - 1) * 86_400_000);

    const device = await db.deviceActivation.findFirstOrThrow({ where: { licenseId: license.id } });
    expect(device).toMatchObject({ fingerprint: fp, name: "Billing counter PC", os: "Windows 11 Pro", appVersion: "4.2.1", deactivatedAt: null });
    const events = await db.licenseEvent.findMany({ where: { licenseId: license.id, type: "activated" } });
    expect(events).toEqual([expect.objectContaining({ actor: DEVICE_ACTOR, detail: "Billing counter PC" })]);
    const activity = await db.accountActivity.findMany({ where: { accountId } });
    expect(activity).toEqual([
      expect.objectContaining({ actorName: DEVICE_ACTOR, action: "Activated device", target: `${license.id} \u00B7 Billing counter PC`, kind: "license" }),
    ]);
  });

  it("accepts the key in any case, with spaces or without dashes, and an upper-case fingerprint", async () => {
    const { license, key } = await issue(cat, cat.plans.annual);
    const fp = newFingerprint();
    const sloppy = ` ${key.toLowerCase().replace(/-/g, " ")} `;
    const res = await activateLicense(activationInput(sloppy, fp.toUpperCase()), { appId: cat.product.code, ip: nextIp() });
    expect(res).toMatchObject({ status: "activated", licenseId: license.id });
    expect(await db.deviceActivation.findFirstOrThrow({ where: { licenseId: license.id } })).toMatchObject({ fingerprint: fp });
  });

  it("answers already_active for the same fingerprint without using another slot or writing an event", async () => {
    const { license, key } = await issue(cat, cat.plans.annual);
    const fp = newFingerprint();
    await activate(key, fp);
    const again = await activateLicense(activationInput(key, fp, { appVersion: "4.3.0", os: "Windows 11 Home" }), {
      appId: cat.product.code,
      ip: nextIp(),
    });

    expect(again).toMatchObject({ status: "already_active", licenseId: license.id, devicesUsed: 1, deviceLimit: 1 });
    expect((await verifyActivationToken(again.activationToken)).claims.fp).toBe(fp);
    const devices = await db.deviceActivation.findMany({ where: { licenseId: license.id } });
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ appVersion: "4.3.0", os: "Windows 11 Home", name: "Billing counter PC" });
    expect(await db.licenseEvent.count({ where: { licenseId: license.id, type: "activated" } })).toBe(1);
  });

  it("refuses a new device at the limit with 409 and the slot details", async () => {
    const { license, key } = await issue(cat, cat.plans.multi);
    for (let i = 0; i < 3; i += 1) await activate(key, newFingerprint());

    const error = await expectApiError(activate(key, newFingerprint()), 409, "activation_limit_reached");
    expect(error.message).toBe("All 3 device slots are in use. Deactivate a computer from your account, or add one.");
    expect(error.details).toEqual({
      devicesUsed: 3,
      deviceLimit: 3,
      manageUrl: `${getEnv().APP_URL}/account/licenses/${license.id}`,
    });
    expect(await activeDevices(license.id)).toBe(3);
  });

  it("refuses expired licenses and ended trials with 403 license_expired", async () => {
    const { key } = await issue(cat, cat.plans.annual, { at: addDays(new Date(), -400) });
    const error = await expectApiError(activate(key, newFingerprint()), 403, "license_expired");
    expect(error.details).toEqual({ expiresAt: expect.any(String) });

    const trial = await issue(cat, cat.plans.trial, { at: addDays(new Date(), -16), status: "TRIAL" });
    const trialError = await expectApiError(activate(trial.key, newFingerprint()), 403, "license_expired");
    expect(trialError.message).toMatch(/free trial has ended/);
  });

  it("refuses suspended licenses with 403 license_suspended", async () => {
    const { license, key } = await issue(cat, cat.plans.annual);
    await db.license.update({ where: { id: license.id }, data: { status: "SUSPENDED" } });
    await expectApiError(activate(key, newFingerprint()), 403, "license_suspended");
    expect(await activeDevices(license.id)).toBe(0);
  });

  it("refuses licenses revoked after a refund with 403 license_revoked", async () => {
    const accountId = await newAccount();
    const { orderId, licenseId, key } = await paidOrderWithLicense(cat.plans.annual, accountId);
    expect((await activate(key, newFingerprint())).status).toBe("activated");

    const revoked = await db.$transaction((tx) => revokeOrderLicenses(tx, orderId, { reason: "Refunded", actor: "System", at: new Date() }));
    expect(revoked).toEqual([licenseId]);
    await expectApiError(activate(key, newFingerprint()), 403, "license_revoked");
  });

  it("checks the license status before the product (revoked beats wrong product)", async () => {
    const { license, key } = await issue(cat, cat.plans.annual);
    await db.license.update({ where: { id: license.id }, data: { status: "REVOKED", revokedAt: new Date(), revokedReason: "Test" } });
    await expectApiError(activate(key, newFingerprint(), { appId: cat.other.code }), 403, "license_revoked");
  });

  it("refuses a key for another product with 422 wrong_product", async () => {
    const { license, key } = await issue(cat, cat.plans.annual);
    await expectApiError(activate(key, newFingerprint(), { appId: cat.other.code }), 422, "wrong_product");
    expect(await activeDevices(license.id)).toBe(0);
  });

  it("answers 404 invalid_key for unknown and malformed keys alike", async () => {
    const unknown = await expectApiError(activate(generateLicenseKey(cat.product.code), newFingerprint()), 404, "invalid_key");
    const malformed = await expectApiError(activate("not a key", newFingerprint()), 404, "invalid_key");
    const empty = await expectApiError(activate("", newFingerprint()), 404, "invalid_key");
    expect(malformed.message).toBe(unknown.message);
    expect(empty.message).toBe(unknown.message);
  });

  it("reports the contract plan names", async () => {
    const cases = [
      [cat.plans.oneTime, "one_time", undefined],
      [cat.plans.subscription, "subscription", undefined],
      [cat.plans.trial, "trial", "TRIAL"],
    ] as const;
    for (const [plan, expected, status] of cases) {
      const { key } = await issue(cat, plan, { status });
      const res = await activate(key, newFingerprint());
      expect(res.plan).toBe(expected);
      if (expected === "one_time") expect(res.expiresAt).toBeNull();
    }
  });

  it("never exceeds the device limit under concurrent activations (N + 2 devices, limit N)", async () => {
    // Several licenses at once, so the activations really overlap in the database.
    const licenses = await Promise.all(Array.from({ length: 4 }, () => issue(cat, cat.plans.multi)));
    const rounds = await Promise.all(
      licenses.map(({ key, license }) =>
        Promise.allSettled(Array.from({ length: license.deviceLimit + 2 }, () => activate(key, newFingerprint()))),
      ),
    );

    for (const [i, outcomes] of rounds.entries()) {
      const { license } = licenses[i] as (typeof licenses)[number];
      const limit = license.deviceLimit;
      const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(limit);
      expect(refused).toHaveLength(2);
      for (const r of refused) expect(r.reason).toMatchObject({ status: 409, code: "activation_limit_reached" });
      expect(await activeDevices(license.id)).toBe(limit);
      expect(await db.licenseEvent.count({ where: { licenseId: license.id, type: "activated" } })).toBe(limit);
    }
  });

  it("gives concurrent activations of the same fingerprint one slot", async () => {
    const { license, key } = await issue(cat, cat.plans.multi);
    const fp = newFingerprint();
    const results = await Promise.all(Array.from({ length: 4 }, () => activate(key, fp)));
    expect(results.map((r) => r.status).sort()).toEqual(["activated", "already_active", "already_active", "already_active"]);
    expect(await activeDevices(license.id)).toBe(1);
  });

  it("caps new computers per license over 30 days, so one slot cannot be passed around with free deactivations", async () => {
    expect([activationChurnLimit(1), activationChurnLimit(2), activationChurnLimit(3), activationChurnLimit(10)]).toEqual([3, 4, 6, 20]);
    const { license, key } = await issue(cat, cat.plans.annual); // 1 slot: 3 new computers per 30 days
    const t0 = new Date();
    const at = (hours: number) => new Date(t0.getTime() + hours * 3_600_000);
    const release = (d: { fp: string; token: string }, now: Date) =>
      deactivateFromDevice({ activationToken: d.token, deviceFingerprint: d.fp }, { appId: cat.product.code, ip: nextIp(), now });

    // Machine 1, 2 and 3 take the slot in turn, each freeing it from the device (not counted as a portal reset).
    let current: { fp: string; token: string } | null = null;
    for (let i = 0; i < 3; i += 1) {
      if (current) await release(current, at(i));
      const fp = newFingerprint();
      current = { fp, token: (await activate(key, fp, { now: at(i + 0.5) })).activationToken };
    }
    if (!current) throw new Error("no device");
    // Reinstalling the active computer is never counted.
    expect((await activate(key, current.fp, { now: at(3) })).status).toBe("already_active");

    await release(current, at(3.5));
    const error = await expectApiError(activate(key, newFingerprint(), { now: at(4) }), 429, "activation_churn");
    expect(error.message).toBe(ACTIVATION_MESSAGES.activationChurn);
    const retryAfterSec = Math.ceil((at(0.5).getTime() + 30 * DAY_MS - at(4).getTime()) / 1000);
    expect(error.details).toEqual({ retryAfterSec });
    expect(error.headers?.["Retry-After"]).toBe(String(retryAfterSec));
    expect(await activeDevices(license.id)).toBe(0);
    expect((await db.license.findUniqueOrThrow({ where: { id: license.id } })).selfServiceResets).toBe(license.selfServiceResets);

    // Once the first activation is older than 30 days, a new computer is allowed again.
    const later = new Date(at(0.5).getTime() + 30 * DAY_MS + 1_000);
    expect((await activate(key, newFingerprint(), { now: later })).status).toBe("activated");
  });

  it("limits attempts per key hash (10 / min), counting unknown keys too", async () => {
    const unknown = generateLicenseKey(cat.product.code);
    const now = new Date();
    for (let i = 0; i < 10; i += 1) await expectApiError(activate(unknown, newFingerprint(), { now }), 404, "invalid_key");
    const limited = await expectApiError(activate(unknown, newFingerprint(), { now }), 429, "too_many_attempts");
    expect(Number(limited.headers?.["Retry-After"])).toBeGreaterThan(0);
    expect(Number(limited.headers?.["Retry-After"])).toBeLessThanOrEqual(60);
    // The same key with dashes removed and lower case is the same bucket.
    await expectApiError(activate(unknown.replace(/-/g, "").toLowerCase(), newFingerprint(), { now }), 429, "too_many_attempts");
    // A minute later the bucket has reset.
    await expectApiError(activate(unknown, newFingerprint(), { now: new Date(now.getTime() + 61_000) }), 404, "invalid_key");
  });

  it("limits attempts per client IP (60 / min) across different keys", async () => {
    const ip = nextIp();
    const now = new Date();
    for (let i = 0; i < 60; i += 1) {
      await expectApiError(activate(generateLicenseKey(cat.product.code), newFingerprint(), { ip, now }), 404, "invalid_key");
    }
    const { key } = await issue(cat, cat.plans.annual);
    const limited = await expectApiError(activate(key, newFingerprint(), { ip, now }), 429, "too_many_attempts");
    expect(Number(limited.headers?.["Retry-After"])).toBeGreaterThan(0);
    // Another address is unaffected.
    expect((await activate(key, newFingerprint(), { now })).status).toBe("activated");
  });

  it("stores cleaned device text and never a key typed into the device name", async () => {
    const accountId = await newAccount();
    const { license, key } = await issue(cat, cat.plans.annual, { accountId });
    await activate(key, newFingerprint(), { name: `Counter\tPC \u202E${key}` });
    const device = await db.deviceActivation.findFirstOrThrow({ where: { licenseId: license.id } });
    expect(device.name).toBe(`Counter PC ${cat.product.code}-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-${key.slice(-4)}`);
    const stored = JSON.stringify([
      device,
      await db.licenseEvent.findMany({ where: { licenseId: license.id } }),
      await db.accountActivity.findMany({ where: { accountId } }),
    ]);
    expect(stored).not.toContain(key.slice(4, -4));
  });
});
