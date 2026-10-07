import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { ItemKind, License, Plan } from "@/generated/prisma/client";
import { addCalendarMonths, addDays } from "@/lib/dates";
import { db } from "@/lib/db";
import type { LicenseKeySecrets } from "@/lib/licensing/crypto";
import { hashLicenseKey } from "@/lib/licensing/crypto";
import { FulfilmentError, fulfilOrderItems, revokeOrderLicenses, type FulfilOrder } from "@/lib/licensing/fulfil";
import { issueLicense } from "@/lib/licensing/issue";
import { LicenseTermsError } from "@/lib/licensing/terms";
import { freshProductCode } from "../support/product-codes";

const secrets: LicenseKeySecrets = { pepper: randomBytes(32).toString("hex"), encKey: randomBytes(32) };
const PAID = new Date("2026-10-06T06:30:00.000Z");
const daysBefore = (n: number) => addDays(PAID, -n);
const tag = randomBytes(3).toString("hex");
/** Product.code is unique across the shared test schema, so each run picks its own codes. */
type Product = { id: string; code: string };
type Plans = { annual: Plan; oneTime: Plan; trial: Plan; perUnit: Plan; addon: Plan; amc: Plan; otherAnnual: Plan };
let product: Product;
let other: Product;
let plans: Plans;

async function makeProduct(id: string, categoryId: string): Promise<Product> {
  return db.product.create({
    data: {
      id,
      code: await freshProductCode(),
      name: `Product ${id}`,
      shortName: id,
      tagline: "Test product",
      summary: "Test product",
      icon: "receipt_long",
      categoryId,
      platforms: ["windows"],
      status: "PUBLISHED",
      content: {},
      relatedIds: [],
    },
    select: { id: true, code: true },
  });
}

type PlanInput = Pick<Plan, "id" | "productId" | "type" | "name"> &
  Partial<Pick<Plan, "interval" | "trialDays" | "deviceLimit" | "perUnit" | "updatesMonths">>;
const makePlan = (p: PlanInput) => db.plan.create({ data: { includes: [], pricePaise: p.type === "TRIAL" ? 0 : 100_000, ...p } });

beforeAll(async () => {
  const category = await db.category.create({ data: { id: `fcat-${tag}`, name: "Test", tone: "peach", icon: "receipt_long" } });
  product = await makeProduct(`gst-${tag}`, category.id);
  other = await makeProduct(`rst-${tag}`, category.id);
  const pid = product.id;
  plans = {
    annual: await makePlan({ id: `f-annual-${tag}`, productId: pid, type: "ANNUAL", name: "Annual license", interval: "YEAR", deviceLimit: 1 }),
    oneTime: await makePlan({ id: `f-onetime-${tag}`, productId: pid, type: "ONE_TIME", name: "One-time license", deviceLimit: 1, updatesMonths: 12 }),
    trial: await makePlan({ id: `f-trial-${tag}`, productId: pid, type: "TRIAL", name: "Free trial", trialDays: 15, deviceLimit: 1 }),
    perUnit: await makePlan({ id: `f-sub-${tag}`, productId: pid, type: "SUBSCRIPTION", name: "Monthly subscription", interval: "MONTH", deviceLimit: 1, perUnit: "terminal" }),
    addon: await makePlan({ id: `f-device-${tag}`, productId: pid, type: "DEVICE_ADDON", name: "Additional computer" }),
    amc: await makePlan({ id: `f-amc-${tag}`, productId: pid, type: "MAINTENANCE", name: "Maintenance & support", interval: "YEAR" }),
    otherAnnual: await makePlan({ id: `f-other-${tag}`, productId: other.id, type: "ANNUAL", name: "Other annual", interval: "YEAR", deviceLimit: 1 }),
  };
});

const newAccount = async () => (await db.businessAccount.create({ data: { legalName: `Store ${randomBytes(2).toString("hex")}` } })).id;

/** An existing license, issued `at` for `accountId` (as a previous order or trial would have). */
async function existing(plan: Plan, accountId: string | null, at: Date, status?: "ACTIVE" | "TRIAL"): Promise<License> {
  const prod = plan.productId === product.id ? product : other;
  const { license } = await db.$transaction((tx) =>
    issueLicense(tx, { accountId, product: prod, plan, qty: 1, at, actor: "System", status, secrets }),
  );
  return license;
}

type ItemSpec = { plan: Plan; kind?: ItemKind; quantity?: number; target?: string | null };
let orderSeq = 0;

async function makeOrder(accountId: string | null, items: ItemSpec[], paidAt = PAID): Promise<FulfilOrder> {
  orderSeq += 1;
  const id = `AX-${tag}-${orderSeq}`;
  await db.order.create({
    data: {
      id,
      accountId,
      email: "priya@example.test",
      billing: { name: "Priya Sharma", state: "Maharashtra" },
      status: "PAID",
      subtotalPaise: 0,
      taxablePaise: 0,
      totalPaise: 0,
      placeOfSupply: "Maharashtra",
      paidAt,
      items: {
        create: items.map((i) => ({
          planId: i.plan.id,
          kind: i.kind ?? "NEW",
          quantity: i.quantity ?? 1,
          unitPricePaise: i.plan.pricePaise,
          taxablePaise: i.plan.pricePaise * (i.quantity ?? 1),
          taxPaise: 0,
          targetLicenseId: i.target ?? null,
        })),
      },
    },
  });
  return { id, accountId, paidAt };
}

const fulfil = (order: FulfilOrder) => db.$transaction((tx) => fulfilOrderItems(tx, order, { secrets }));
const reload = (id: string) => db.license.findUniqueOrThrow({ where: { id } });
const eventsOf = (id: string) => db.licenseEvent.findMany({ where: { licenseId: id }, orderBy: { createdAt: "asc" } });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

describe("NEW items", () => {
  it("issues one license per item from paidAt and marks the items fulfilled", async () => {
    const accountId = await newAccount();
    const order = await makeOrder(accountId, [{ plan: plans.annual }, { plan: plans.perUnit, quantity: 3 }]);
    const results = await fulfil(order);
    expect(results).toHaveLength(2);
    const items = await db.orderItem.findMany({ where: { orderId: order.id } });
    for (const result of results) {
      expect(result.action).toBe("issued");
      const item = items.find((i) => i.id === result.itemId);
      expect(item).toMatchObject({ issuedLicenseId: result.licenseId, fulfilledAt: PAID });
      const license = await reload(result.licenseId);
      expect(license).toMatchObject({ orderId: order.id, accountId, issuedAt: PAID, status: "ACTIVE" });
      expect(license.keyHash).toBe(hashLicenseKey(result.key ?? "", secrets.pepper));
    }
    const byPlan = new Map<string, License>();
    for (const r of results) {
      const l = await reload(r.licenseId);
      byPlan.set(l.planId, l);
    }
    expect(byPlan.get(plans.annual.id)).toMatchObject({ expiresAt: addDays(PAID, 365), deviceLimit: 1 });
    expect(byPlan.get(plans.perUnit.id)).toMatchObject({ expiresAt: addCalendarMonths(PAID, 1), deviceLimit: 3 });
    expect(new Set(results.map((r) => r.key)).size).toBe(2);
  });

  it("is idempotent: a second run issues nothing", async () => {
    const order = await makeOrder(await newAccount(), [{ plan: plans.annual }]);
    const first = await fulfil(order);
    const counter = await db.counter.findUnique({ where: { key: "license" } });
    const licenses = await db.license.count();
    expect(await fulfil(order)).toEqual([]);
    expect(await db.license.count()).toBe(licenses);
    expect(await db.counter.findUnique({ where: { key: "license" } })).toEqual(counter);
    expect((await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).issuedLicenseId).toBe(first[0]?.licenseId);
  });

  it("issues guest licenses without an account", async () => {
    const order = await makeOrder(null, [{ plan: plans.oneTime }]);
    const [result] = await fulfil(order);
    expect(await reload(result?.licenseId ?? "")).toMatchObject({ accountId: null, expiresAt: null, updatesUntil: addCalendarMonths(PAID, 12) });
  });

  it("refuses trial plans and plans that need a target", async () => {
    const accountId = await newAccount();
    const trialErr = await rejection(fulfil(await makeOrder(accountId, [{ plan: plans.trial }])));
    expect(trialErr).toBeInstanceOf(FulfilmentError);
    expect((trialErr as FulfilmentError).code).toBe("invalid_item");
    const addonErr = await rejection(fulfil(await makeOrder(accountId, [{ plan: plans.addon }])));
    expect(addonErr).toBeInstanceOf(LicenseTermsError);
    expect((addonErr as LicenseTermsError).code).toBe("needs_target_license");
  });

  it("requires a valid paidAt", async () => {
    const order = await makeOrder(await newAccount(), [{ plan: plans.annual }]);
    await expect(fulfil({ ...order, paidAt: new Date(Number.NaN) })).rejects.toThrow(RangeError);
  });
});

describe("RENEWAL items", () => {
  it("extends an active license from its current expiry (early renewal keeps unused time)", async () => {
    const accountId = await newAccount();
    const license = await existing(plans.annual, accountId, daysBefore(300));
    const order = await makeOrder(accountId, [{ plan: plans.annual, kind: "RENEWAL", target: license.id }]);
    const [result] = await fulfil(order);
    expect(result).toEqual({ itemId: expect.any(String), action: "renewed", licenseId: license.id });
    expect(await reload(license.id)).toMatchObject({
      expiresAt: addDays(daysBefore(300), 730),
      updatesUntil: addDays(daysBefore(300), 730),
      status: "ACTIVE",
      keyHash: license.keyHash,
    });
    const events = await eventsOf(license.id);
    expect(events.at(-1)).toMatchObject({ type: "renewed", actor: "System", detail: `Annual license \u00B7 Order ${order.id}` });
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(item.issuedLicenseId).toBeNull();
    expect(item.termsBefore).toMatchObject({ planId: license.planId, status: "ACTIVE", expiresAt: license.expiresAt?.toISOString(), deviceLimit: license.deviceLimit });
    expect(item.termsAfter).toMatchObject({ planId: plans.annual.id, expiresAt: addDays(daysBefore(300), 730).toISOString() });
  });

  it("starts a late renewal at paidAt", async () => {
    const accountId = await newAccount();
    const license = await existing(plans.annual, accountId, daysBefore(400));
    await fulfil(await makeOrder(accountId, [{ plan: plans.annual, kind: "RENEWAL", target: license.id }]));
    expect(await reload(license.id)).toMatchObject({ expiresAt: addDays(PAID, 365) });
  });

  it("renews per-unit subscriptions with the renewed terminal count", async () => {
    const accountId = await newAccount();
    const license = await existing(plans.perUnit, accountId, daysBefore(10));
    await fulfil(await makeOrder(accountId, [{ plan: plans.perUnit, kind: "RENEWAL", quantity: 5, target: license.id }]));
    expect(await reload(license.id)).toMatchObject({ deviceLimit: 5, expiresAt: addCalendarMonths(license.expiresAt ?? PAID, 1) });
  });

  it("MAINTENANCE moves only updatesUntil, by 12 months from the later of paidAt and updatesUntil", async () => {
    const accountId = await newAccount();
    const license = await existing(plans.oneTime, accountId, daysBefore(100));
    const order = await makeOrder(accountId, [{ plan: plans.amc, kind: "RENEWAL", target: license.id }]);
    const [result] = await fulfil(order);
    expect(result?.action).toBe("maintenance");
    expect(await reload(license.id)).toMatchObject({
      planId: plans.oneTime.id,
      expiresAt: null,
      updatesUntil: addCalendarMonths(license.updatesUntil, 12),
      deviceLimit: 1,
    });

    const lapsed = await existing(plans.oneTime, accountId, daysBefore(500));
    await fulfil(await makeOrder(accountId, [{ plan: plans.amc, kind: "RENEWAL", target: lapsed.id }]));
    expect((await reload(lapsed.id)).updatesUntil).toEqual(addCalendarMonths(PAID, 12));
  });

  it("refuses MAINTENANCE on an annual license and leaves it untouched", async () => {
    const accountId = await newAccount();
    const annual = await existing(plans.annual, accountId, daysBefore(100));
    const err = await rejection(fulfil(await makeOrder(accountId, [{ plan: plans.amc, kind: "RENEWAL", target: annual.id }])));
    expect(err).toBeInstanceOf(LicenseTermsError);
    expect((err as LicenseTermsError).code).toBe("not_renewable");
    expect(await reload(annual.id)).toMatchObject({ expiresAt: annual.expiresAt, updatesUntil: annual.updatesUntil });
  });

  it("refuses to turn a perpetual license into an annual one, or to renew a trial", async () => {
    const accountId = await newAccount();
    const perpetual = await existing(plans.oneTime, accountId, daysBefore(10));
    const termsErr = await rejection(fulfil(await makeOrder(accountId, [{ plan: plans.annual, kind: "RENEWAL", target: perpetual.id }])));
    expect((termsErr as LicenseTermsError).code).toBe("not_renewable");
    const trial = await existing(plans.trial, accountId, daysBefore(3));
    const trialErr = await rejection(fulfil(await makeOrder(accountId, [{ plan: plans.annual, kind: "RENEWAL", target: trial.id }])));
    expect((trialErr as FulfilmentError).code).toBe("invalid_item");
  });
});

describe("ADDON and UPGRADE items", () => {
  it("adds device slots without touching the dates", async () => {
    const accountId = await newAccount();
    const license = await existing(plans.annual, accountId, daysBefore(30));
    const order = await makeOrder(accountId, [{ plan: plans.addon, kind: "ADDON", quantity: 2, target: license.id }]);
    const [result] = await fulfil(order);
    expect(result?.action).toBe("devices_added");
    expect(await reload(license.id)).toMatchObject({ deviceLimit: 3, expiresAt: license.expiresAt, updatesUntil: license.updatesUntil });
    expect((await eventsOf(license.id)).at(-1)).toMatchObject({ type: "devices_added", detail: `+2 devices \u00B7 Order ${order.id}` });
  });

  it("refuses add-ons with the wrong plan type or on a trial", async () => {
    const accountId = await newAccount();
    const license = await existing(plans.annual, accountId, daysBefore(30));
    const wrongPlan = await rejection(fulfil(await makeOrder(accountId, [{ plan: plans.annual, kind: "ADDON", target: license.id }])));
    expect((wrongPlan as FulfilmentError).code).toBe("invalid_item");
    const trial = await existing(plans.trial, accountId, daysBefore(2));
    const onTrial = await rejection(fulfil(await makeOrder(accountId, [{ plan: plans.addon, kind: "ADDON", target: trial.id }])));
    expect((onTrial as FulfilmentError).code).toBe("invalid_item");
  });

  it("upgrades a trial in place: same key, paid plan, ACTIVE, fresh terms from paidAt", async () => {
    const accountId = await newAccount();
    const trial = await existing(plans.trial, accountId, daysBefore(5));
    expect(trial.status).toBe("TRIAL");
    const order = await makeOrder(accountId, [{ plan: plans.annual, kind: "UPGRADE", target: trial.id }]);
    const [result] = await fulfil(order);
    expect(result).toEqual({ itemId: expect.any(String), action: "upgraded", licenseId: trial.id });
    expect(await reload(trial.id)).toMatchObject({
      planId: plans.annual.id,
      status: "ACTIVE",
      expiresAt: addDays(PAID, 365),
      updatesUntil: addDays(PAID, 365),
      keyHash: trial.keyHash,
      keyCiphertext: trial.keyCiphertext,
    });
    expect((await eventsOf(trial.id)).at(-1)).toMatchObject({ type: "upgraded", detail: `Annual license \u00B7 Order ${order.id}` });
  });

  it("upgrades an annual license to one-time", async () => {
    const accountId = await newAccount();
    const license = await existing(plans.annual, accountId, daysBefore(60));
    await fulfil(await makeOrder(accountId, [{ plan: plans.oneTime, kind: "UPGRADE", target: license.id }]));
    expect(await reload(license.id)).toMatchObject({ planId: plans.oneTime.id, expiresAt: null, status: "ACTIVE" });
  });
});

describe("target checks", () => {
  it("rolls back the whole order when one item targets another account's license", async () => {
    const mine = await newAccount();
    const theirs = await existing(plans.annual, await newAccount(), daysBefore(30));
    const order = await makeOrder(mine, [{ plan: plans.annual }, { plan: plans.annual, kind: "RENEWAL", target: theirs.id }]);
    const err = await rejection(fulfil(order));
    expect(err).toBeInstanceOf(FulfilmentError);
    expect((err as FulfilmentError).code).toBe("target_wrong_account");
    expect(await db.license.count({ where: { orderId: order.id } })).toBe(0);
    expect(await db.orderItem.count({ where: { orderId: order.id, fulfilledAt: { not: null } } })).toBe(0);
    expect(await reload(theirs.id)).toMatchObject({ expiresAt: theirs.expiresAt });
  });

  it("checks presence, ownership, product and revocation of the target", async () => {
    const accountId = await newAccount();
    const otherProduct = await existing(plans.otherAnnual, accountId, daysBefore(30));
    const revoked = await existing(plans.annual, accountId, daysBefore(30));
    await db.license.update({ where: { id: revoked.id }, data: { status: "REVOKED", revokedAt: daysBefore(1) } });
    const unclaimed = await existing(plans.annual, null, daysBefore(30));

    const cases: Array<[string | null, ItemSpec, string]> = [
      [accountId, { plan: plans.annual, kind: "RENEWAL", target: null }, "missing_target"],
      [accountId, { plan: plans.annual, kind: "RENEWAL", target: "LIC-0" }, "target_not_found"],
      [accountId, { plan: plans.annual, kind: "RENEWAL", target: otherProduct.id }, "target_wrong_product"],
      [accountId, { plan: plans.annual, kind: "RENEWAL", target: revoked.id }, "target_revoked"],
      [accountId, { plan: plans.annual, kind: "RENEWAL", target: unclaimed.id }, "target_wrong_account"],
      [null, { plan: plans.annual, kind: "RENEWAL", target: unclaimed.id }, "target_wrong_account"],
    ];
    for (const [owner, item, code] of cases) {
      const err = await rejection(fulfil(await makeOrder(owner, [item])));
      expect(err, code).toBeInstanceOf(FulfilmentError);
      expect((err as FulfilmentError).code).toBe(code);
    }
  });
});

describe("revokeOrderLicenses", () => {
  it("revokes only the licenses the order issued, once", async () => {
    const accountId = await newAccount();
    const renewed = await existing(plans.annual, accountId, daysBefore(200));
    const order = await makeOrder(accountId, [
      { plan: plans.annual },
      { plan: plans.oneTime },
      { plan: plans.annual, kind: "RENEWAL", target: renewed.id },
    ]);
    const results = await fulfil(order);
    const issued = results.filter((r) => r.action === "issued").map((r) => r.licenseId).sort();
    expect(issued).toHaveLength(2);

    const at = addDays(PAID, 3);
    const reason = `Order ${order.id} was refunded at your request.`;
    const revoke = () => db.$transaction((tx) => revokeOrderLicenses(tx, order.id, { reason, actor: "Karan Mehta", at }));
    expect(await revoke()).toEqual(issued);
    for (const id of issued) {
      expect(await reload(id)).toMatchObject({ status: "REVOKED", revokedAt: at, revokedReason: reason });
      expect((await eventsOf(id)).at(-1)).toMatchObject({ type: "revoked", actor: "Karan Mehta", detail: reason });
    }
    expect((await reload(renewed.id)).status).toBe("ACTIVE");
    expect(await revoke()).toEqual([]);
    expect(await db.licenseEvent.count({ where: { licenseId: { in: issued }, type: "revoked" } })).toBe(2);
  });

  it("requires a reason", async () => {
    await expect(
      db.$transaction((tx) => revokeOrderLicenses(tx, "AX-none", { reason: "  ", actor: "System", at: PAID })),
    ).rejects.toThrow(RangeError);
  });
});
