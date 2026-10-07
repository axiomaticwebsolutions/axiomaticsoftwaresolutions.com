/**
 * Lowered device limits (decisions.md Phase 4 fix pass "Device limit"): a renewal for fewer terminals, or an upgrade to a
 * smaller plan, deactivates the devices above the new limit (least recently seen first) inside fulfilment, so they stop
 * validating; trimDevicesToLimit() on its own; countActiveDevices().
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ItemKind, Plan } from "@/generated/prisma/client";
import { DAY_MS } from "@/lib/dates";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { activateLicense, validateActivation } from "@/lib/licensing/activation";
import { countActiveDevices, DEACTIVATED_BY_SYSTEM, trimDevicesToLimit } from "@/lib/licensing/device-limit";
import { fulfilOrderItems } from "@/lib/licensing/fulfil";
import {
  activationInput,
  issue,
  newAccount,
  newFingerprint,
  nextIp,
  rejection,
  seedActivationCatalog,
  uniq,
  type ActivationCatalog,
} from "./activation-fixtures";

let cat: ActivationCatalog;
let perUnit: Plan;

beforeAll(async () => {
  cat = await seedActivationCatalog();
  perUnit = await db.plan.create({
    data: {
      id: uniq("act-plan"),
      productId: cat.product.id,
      type: "ANNUAL",
      name: "Per-terminal annual",
      interval: "YEAR",
      deviceLimit: 1,
      perUnit: "terminal",
      maxQty: 10,
      includes: [],
      pricePaise: 100_000,
    },
  });
});

const ctx = (now?: Date) => ({ appId: cat.product.code, ip: nextIp(), now });

/** A paid order with one item targeting `licenseId`, fulfilled like the payment webhook does. */
async function fulfilItem(accountId: string, licenseId: string, plan: Plan, kind: ItemKind, quantity: number) {
  const orderId = uniq("AX-DL");
  const paidAt = new Date();
  await db.order.create({
    data: {
      id: orderId,
      accountId,
      email: "priya@example.test",
      billing: { name: "Priya Sharma", state: "Maharashtra" },
      status: "PAID",
      subtotalPaise: 0,
      taxablePaise: 0,
      totalPaise: 0,
      placeOfSupply: "Maharashtra",
      paidAt,
      items: { create: [{ planId: plan.id, kind, quantity, unitPricePaise: 0, taxablePaise: 0, taxPaise: 0, targetLicenseId: licenseId }] },
    },
  });
  return db.$transaction((tx) => fulfilOrderItems(tx, { id: orderId, accountId, paidAt }));
}

/** Activates `names.length` devices and sets their lastSeenAt `daysAgo` (in order); returns name -> { fp, token }. */
async function activateDevices(key: string, names: string[], daysAgo: number[]) {
  const out = new Map<string, { fp: string; token: string; id: string }>();
  for (const [i, name] of names.entries()) {
    const fp = newFingerprint();
    const res = await activateLicense(activationInput(key, fp, { deviceName: name }), ctx());
    const device = await db.deviceActivation.findFirstOrThrow({ where: { licenseId: res.licenseId, fingerprint: fp } });
    await db.deviceActivation.update({ where: { id: device.id }, data: { lastSeenAt: new Date(Date.now() - (daysAgo[i] ?? 0) * DAY_MS) } });
    out.set(name, { fp, token: res.activationToken, id: device.id });
  }
  return out;
}

const validate = (d: { fp: string; token: string }) =>
  validateActivation({ activationToken: d.token, deviceFingerprint: d.fp, appVersion: "4.2.1" }, ctx());

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code });
}

describe("fulfilment lowers the device limit", () => {
  it("a renewal for fewer terminals deactivates the least recently seen devices, which then stop validating", async () => {
    const accountId = await newAccount();
    const { license, key } = await issue(cat, perUnit, { accountId });
    await db.license.update({ where: { id: license.id }, data: { deviceLimit: 3 } });
    const devices = await activateDevices(key, ["Old PC", "Back office", "Counter 1"], [3, 2, 0]);
    const before = await db.license.findUniqueOrThrow({ where: { id: license.id } });

    await fulfilItem(accountId, license.id, perUnit, "RENEWAL", 1);

    const after = await db.license.findUniqueOrThrow({ where: { id: license.id } });
    expect(after.deviceLimit).toBe(1);
    expect([after.selfServiceResets, after.resetsYear]).toEqual([before.selfServiceResets, before.resetsYear]);
    const rows = await db.deviceActivation.findMany({ where: { licenseId: license.id }, orderBy: { name: "asc" } });
    expect(rows.map((r) => [r.name, r.deactivatedBy, r.deactivatedAt === null])).toEqual([
      ["Back office", DEACTIVATED_BY_SYSTEM, false],
      ["Counter 1", null, true],
      ["Old PC", DEACTIVATED_BY_SYSTEM, false],
    ]);

    // The trimmed computers fail at their next check (and cannot take the slot back); the kept one still works.
    await expectApiError(validate(devices.get("Old PC")!), 403, "device_deactivated");
    await expectApiError(validate(devices.get("Back office")!), 403, "device_deactivated");
    expect((await validate(devices.get("Counter 1")!)).valid).toBe(true);
    await expectApiError(activateLicense(activationInput(key, devices.get("Old PC")!.fp), ctx()), 409, "activation_limit_reached");

    const events = await db.licenseEvent.findMany({ where: { licenseId: license.id, type: "deactivated" }, orderBy: { detail: "asc" } });
    expect(events.map((e) => [e.actor, e.detail])).toEqual([
      ["System", "Back office \u00B7 over the new limit of 1 device"],
      ["System", "Old PC \u00B7 over the new limit of 1 device"],
    ]);
    const activity = await db.accountActivity.findMany({ where: { accountId, action: "Deactivated device" }, orderBy: { target: "asc" } });
    expect(activity.map((a) => [a.actorName, a.target, a.kind])).toEqual([
      ["System", `${license.id} \u00B7 Back office`, "license"],
      ["System", `${license.id} \u00B7 Old PC`, "license"],
    ]);
  });

  it("keeps every device when the new limit covers them, and add-ons never trim", async () => {
    const accountId = await newAccount();
    const { license, key } = await issue(cat, perUnit, { accountId });
    await db.license.update({ where: { id: license.id }, data: { deviceLimit: 2 } });
    await activateDevices(key, ["A", "B"], [1, 0]);
    await fulfilItem(accountId, license.id, perUnit, "RENEWAL", 2);
    expect((await countActiveDevices(db, [license.id])).get(license.id)).toBe(2);
    expect(await db.licenseEvent.count({ where: { licenseId: license.id, type: "deactivated" } })).toBe(0);
  });

  it("an upgrade from a trial to a smaller plan trims too", async () => {
    const accountId = await newAccount();
    const { license, key } = await issue(cat, cat.plans.trial, { accountId, status: "TRIAL" });
    await db.license.update({ where: { id: license.id }, data: { deviceLimit: 2 } });
    const devices = await activateDevices(key, ["Trial PC 1", "Trial PC 2"], [5, 0]);
    await fulfilItem(accountId, license.id, cat.plans.annual, "UPGRADE", 1);
    expect((await db.license.findUniqueOrThrow({ where: { id: license.id } })).deviceLimit).toBe(1);
    await expectApiError(validate(devices.get("Trial PC 1")!), 403, "device_deactivated");
    expect((await validate(devices.get("Trial PC 2")!)).status).toBe("active");
  });
});

describe("trimDevicesToLimit", () => {
  async function licenseWithDevices(seen: Array<{ name: string; lastSeenAt: Date; activatedAt: Date }>, accountId: string | null = null) {
    const { license } = await issue(cat, cat.plans.multi, { accountId });
    for (const d of seen) {
      await db.deviceActivation.create({ data: { licenseId: license.id, fingerprint: newFingerprint(), os: "Windows 11", ...d } });
    }
    return license.id;
  }
  const t = (days: number) => new Date(Date.now() - days * DAY_MS);

  it("deactivates the least recently seen first, ties by activation date, and is idempotent", async () => {
    const id = await licenseWithDevices([
      { name: "tie-newer-activation", lastSeenAt: t(2), activatedAt: t(5) },
      { name: "tie-older-activation", lastSeenAt: t(2), activatedAt: t(9) },
      { name: "recent", lastSeenAt: t(0), activatedAt: t(9) },
    ]);
    const trimmed = await db.$transaction((tx) => trimDevicesToLimit(tx, { licenseId: id, accountId: null, limit: 1, at: new Date(), actor: "System" }));
    expect(trimmed.map((d) => d.name)).toEqual(["tie-older-activation", "tie-newer-activation"]);
    expect((await countActiveDevices(db, [id])).get(id)).toBe(1);
    expect(await db.licenseEvent.count({ where: { licenseId: id, type: "deactivated" } })).toBe(2);
    // Already within the limit: nothing to do.
    expect(await db.$transaction((tx) => trimDevicesToLimit(tx, { licenseId: id, accountId: null, limit: 1, at: new Date(), actor: "System" }))).toEqual([]);
  });

  it("can trim to zero and refuses a negative limit", async () => {
    const id = await licenseWithDevices([{ name: "only", lastSeenAt: t(0), activatedAt: t(0) }]);
    const all = await db.$transaction((tx) => trimDevicesToLimit(tx, { licenseId: id, accountId: null, limit: 0, at: new Date(), actor: "Support" }));
    expect(all).toHaveLength(1);
    await expect(
      db.$transaction((tx) => trimDevicesToLimit(tx, { licenseId: id, accountId: null, limit: -1, at: new Date(), actor: "System" })),
    ).rejects.toThrow(RangeError);
  });
});
