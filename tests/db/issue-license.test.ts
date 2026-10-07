import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "@/generated/prisma/client";
import { addCalendarMonths, addDays, istCalendarYear } from "@/lib/dates";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { decryptLicenseKey, hashLicenseKey, type LicenseKeySecrets } from "@/lib/licensing/crypto";
import {
  issueLicense,
  LicenseKeyCollisionError,
  startTrial,
  TRIAL_USED_MESSAGE,
  type StartTrialInput,
} from "@/lib/licensing/issue";
import { LICENSE_KEY_RE } from "@/lib/licensing/keys";
import type * as KeysModule from "@/lib/licensing/keys";
import { LicenseTermsError } from "@/lib/licensing/terms";
import { freshProductCode } from "../support/product-codes";

// Lets a test force the next generated keys (collision handling); otherwise the real generator runs.
const { forcedKeys } = vi.hoisted(() => ({ forcedKeys: [] as string[] }));
vi.mock("@/lib/licensing/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof KeysModule>();
  return {
    ...actual,
    generateLicenseKey: (code: string, randomInt?: (max: number) => number) => forcedKeys.shift() ?? actual.generateLicenseKey(code, randomInt),
  };
});

const secrets: LicenseKeySecrets = { pepper: randomBytes(32).toString("hex"), encKey: randomBytes(32) };
const AT = new Date("2026-10-06T06:30:00.000Z");
const tag = randomBytes(3).toString("hex");
/** Product.code is unique across the shared test schema, so each run picks its own codes. */

type Fixture = {
  product: { id: string; code: string };
  other: { id: string; code: string };
  plans: { annual: Plan; oneTime: Plan; trial: Plan; perUnit: Plan; addon: Plan; otherAnnual: Plan; otherTrialArchived: Plan };
};
let fx: Fixture;

async function makeProduct(id: string, code: string, categoryId: string) {
  return db.product.create({
    data: {
      id,
      code,
      name: `Product ${code}`,
      shortName: code,
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

type PlanInput = Pick<Plan, "id" | "productId" | "type"> & Partial<Pick<Plan, "interval" | "trialDays" | "deviceLimit" | "perUnit" | "updatesMonths" | "archived">>;
const makePlan = (p: PlanInput) =>
  db.plan.create({ data: { name: p.id, includes: [], pricePaise: p.type === "TRIAL" ? 0 : 100_000, ...p } });

beforeAll(async () => {
  const category = await db.category.create({ data: { id: `cat-${tag}`, name: "Test", tone: "sage", icon: "receipt_long" } });
  const product = await makeProduct(`medical-${tag}`, await freshProductCode(), category.id);
  const otherCode = await freshProductCode();
  const other = await makeProduct(`cheque-${tag}`, otherCode, category.id);
  fx = {
    product,
    other,
    plans: {
      annual: await makePlan({ id: `med-annual-${tag}`, productId: product.id, type: "ANNUAL", interval: "YEAR", deviceLimit: 1 }),
      oneTime: await makePlan({ id: `med-onetime-${tag}`, productId: product.id, type: "ONE_TIME", deviceLimit: 3, updatesMonths: 12 }),
      trial: await makePlan({ id: `med-trial-${tag}`, productId: product.id, type: "TRIAL", trialDays: 15, deviceLimit: 1 }),
      perUnit: await makePlan({ id: `med-sub-${tag}`, productId: product.id, type: "SUBSCRIPTION", interval: "MONTH", deviceLimit: 1, perUnit: "terminal" }),
      addon: await makePlan({ id: `med-device-${tag}`, productId: product.id, type: "DEVICE_ADDON" }),
      otherAnnual: await makePlan({ id: `chq-annual-${tag}`, productId: other.id, type: "ANNUAL", interval: "YEAR", deviceLimit: 1 }),
      otherTrialArchived: await makePlan({ id: `chq-trial-${tag}`, productId: other.id, type: "TRIAL", trialDays: 7, deviceLimit: 1, archived: true }),
    },
  };
});

beforeEach(() => {
  forcedKeys.length = 0;
});

const issue = (plan: Plan, extra: Partial<Parameters<typeof issueLicense>[1]> = {}) =>
  db.$transaction((tx) =>
    issueLicense(tx, { accountId: null, product: fx.product, plan, qty: 1, at: AT, orderId: null, actor: "System", secrets, ...extra }),
  );

describe("issueLicense", () => {
  it("persists only the hash, ciphertext and last four characters of the key", async () => {
    const { license, key } = await issue(fx.plans.annual, { orderId: "AX-77001" });
    expect(key).toMatch(LICENSE_KEY_RE);
    expect(key.startsWith(`${fx.product.code}-`)).toBe(true);
    expect(license.keyHash).toBe(hashLicenseKey(key, secrets.pepper));
    expect(decryptLicenseKey(license.keyCiphertext, secrets.encKey)).toBe(key);
    expect(license.keyLast4).toBe(key.slice(-4));

    const row = await db.license.findUniqueOrThrow({ where: { id: license.id } });
    const events = await db.licenseEvent.findMany({ where: { licenseId: license.id } });
    const audit = await db.auditLog.findMany({ where: { targetId: license.id } });
    const stored = JSON.stringify([row, events, audit]);
    const secretPart = key.slice(4, -4); // the twelve characters that are never shown
    for (const fragment of [key, key.replace(/-/g, ""), secretPart, secretPart.replace(/-/g, "")]) {
      expect(stored).not.toContain(fragment);
    }
  });

  it("takes the id from the license counter", async () => {
    // Never move the shared counter backwards: ids below its current value may already exist (other test files).
    const current = (await db.counter.findUnique({ where: { key: "license" } }))?.next ?? 0;
    const start = Math.max(25_000, current);
    await db.counter.upsert({ where: { key: "license" }, create: { key: "license", next: start }, update: { next: start } });
    const a = await issue(fx.plans.annual);
    const b = await issue(fx.plans.annual);
    expect([a.license.id, b.license.id]).toEqual([`LIC-${start}`, `LIC-${start + 1}`]);
  });

  it("sets annual terms from the base time and records the issue event", async () => {
    const { license } = await issue(fx.plans.annual, { orderId: "AX-77002", accountId: null });
    expect(license).toMatchObject({
      productId: fx.product.id,
      planId: fx.plans.annual.id,
      orderId: "AX-77002",
      accountId: null,
      status: "ACTIVE",
      issuedAt: AT,
      expiresAt: addDays(AT, 365),
      updatesUntil: addDays(AT, 365),
      deviceLimit: 1,
      selfServiceResets: 0,
      resetsYear: istCalendarYear(AT),
    });
    const events = await db.licenseEvent.findMany({ where: { licenseId: license.id } });
    expect(events).toEqual([expect.objectContaining({ type: "issued", actor: "System", detail: "Order AX-77002" })]);
  });

  it("sets one-time, per-unit and trial terms", async () => {
    const oneTime = (await issue(fx.plans.oneTime)).license;
    expect(oneTime).toMatchObject({ expiresAt: null, updatesUntil: addCalendarMonths(AT, 12), deviceLimit: 3, status: "ACTIVE" });

    const perUnit = (await issue(fx.plans.perUnit, { qty: 4 })).license;
    expect(perUnit).toMatchObject({ expiresAt: addCalendarMonths(AT, 1), deviceLimit: 4 });

    const trial = (await issue(fx.plans.trial, { actor: "Priya Sharma" })).license;
    expect(trial).toMatchObject({ status: "TRIAL", expiresAt: addDays(AT, 15), deviceLimit: 1 });
    const events = await db.licenseEvent.findMany({ where: { licenseId: trial.id } });
    expect(events).toEqual([expect.objectContaining({ type: "trial_started", actor: "Priya Sharma", detail: null })]);
  });

  it("counts self-service resets in the IST calendar year", async () => {
    const newYearIst = new Date("2026-12-31T19:00:00.000Z"); // 1 Jan 2027, 00:30 IST
    const { license } = await issue(fx.plans.annual, { at: newYearIst });
    expect(license.resetsYear).toBe(2027);
  });

  it("masks key-shaped text in event details", async () => {
    const { license } = await issue(fx.plans.annual, { eventDetail: "Replaces MED-7Q4K-9XTP-W2HD-K8NM" });
    const [event] = await db.licenseEvent.findMany({ where: { licenseId: license.id } });
    expect(event?.detail).toBe("Replaces MED-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-K8NM");
  });

  it("refuses plans of another product and plans that need a target, without using an id", async () => {
    const before = await db.counter.findUnique({ where: { key: "license" } });
    await expect(issue(fx.plans.otherAnnual)).rejects.toThrow(/does not belong/);
    await expect(issue(fx.plans.addon)).rejects.toBeInstanceOf(LicenseTermsError);
    await expect(issue(fx.plans.annual, { qty: 0 })).rejects.toBeInstanceOf(LicenseTermsError);
    expect(await db.counter.findUnique({ where: { key: "license" } })).toEqual(before);
  });

  it("generates a new key when the first one collides", async () => {
    const existing = await issue(fx.plans.annual);
    const fresh = `${fx.product.code}-2222-3333-4444-5555`;
    forcedKeys.push(existing.key, fresh);
    const second = await issue(fx.plans.annual);
    expect(second.key).toBe(fresh);
    expect(second.license.keyHash).toBe(hashLicenseKey(fresh, secrets.pepper));
  });

  it("gives up after three collisions and rolls back", async () => {
    const existing = await issue(fx.plans.annual);
    const count = await db.license.count();
    forcedKeys.push(existing.key, existing.key, existing.key);
    await expect(issue(fx.plans.annual)).rejects.toBeInstanceOf(LicenseKeyCollisionError);
    expect(await db.license.count()).toBe(count);
  });
});

describe("startTrial", () => {
  const verified = { id: "user-priya", name: "Priya Sharma", emailVerifiedAt: new Date("2026-09-01T00:00:00.000Z") };
  const newAccount = () => db.businessAccount.create({ data: { legalName: `Sharma Medicals ${randomBytes(2).toString("hex")}` } });
  const trial = (accountId: string, productId: string, user: StartTrialInput["user"] = verified) =>
    db.$transaction((tx) => startTrial(tx, { accountId, productId, user, at: AT, secrets }));

  async function apiError(promise: Promise<unknown>): Promise<ApiError> {
    const e = await promise.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }

  it("needs a verified email and creates nothing otherwise", async () => {
    const account = await newAccount();
    const e = await apiError(trial(account.id, fx.product.id, { ...verified, emailVerifiedAt: null }));
    expect({ status: e.status, code: e.code }).toEqual({ status: 403, code: "email_unverified" });
    expect(await db.license.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("issues a TRIAL license from the trial plan", async () => {
    const account = await newAccount();
    const { license, key } = await trial(account.id, fx.product.id);
    expect(key).toMatch(LICENSE_KEY_RE);
    expect(license).toMatchObject({
      accountId: account.id,
      planId: fx.plans.trial.id,
      orderId: null,
      status: "TRIAL",
      expiresAt: addDays(AT, 15),
      updatesUntil: addDays(AT, 15),
      deviceLimit: 1,
    });
    const events = await db.licenseEvent.findMany({ where: { licenseId: license.id } });
    expect(events).toEqual([expect.objectContaining({ type: "trial_started", actor: "Priya Sharma" })]);
  });

  it("allows one trial per product per account (409 trial_used)", async () => {
    const account = await newAccount();
    await trial(account.id, fx.product.id);
    const e = await apiError(trial(account.id, fx.product.id));
    expect({ status: e.status, code: e.code, message: e.message }).toEqual({ status: 409, code: "trial_used", message: TRIAL_USED_MESSAGE });
    expect(TRIAL_USED_MESSAGE).toBe("You\u2019ve already used the free trial for this product.");
    // Another account may still start its own trial.
    await expect(trial((await newAccount()).id, fx.product.id)).resolves.toMatchObject({ license: { status: "TRIAL" } });
  });

  it("still counts a trial that was upgraded to a paid plan", async () => {
    const account = await newAccount();
    const { license } = await trial(account.id, fx.product.id);
    await db.license.update({ where: { id: license.id }, data: { planId: fx.plans.annual.id, status: "ACTIVE" } });
    expect((await apiError(trial(account.id, fx.product.id))).code).toBe("trial_used");
  });

  it("lets only one of two concurrent trial starts through", async () => {
    const account = await newAccount();
    const results = await Promise.allSettled([trial(account.id, fx.product.id), trial(account.id, fx.product.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect((rejected?.reason as ApiError).code).toBe("trial_used");
    expect(await db.license.count({ where: { accountId: account.id } })).toBe(1);
  });

  it("refuses products without a live trial plan, unknown products and unknown accounts", async () => {
    const account = await newAccount();
    const noTrial = await apiError(trial(account.id, fx.other.id));
    expect({ status: noTrial.status, code: noTrial.code }).toEqual({ status: 422, code: "trial_unavailable" });
    expect((await apiError(trial(account.id, "no-such-product"))).status).toBe(404);
    expect((await apiError(trial("no-such-account", fx.product.id))).status).toBe(404);
  });

  it("refuses unpublished products", async () => {
    const account = await newAccount();
    await db.product.update({ where: { id: fx.product.id }, data: { status: "DRAFT" } });
    try {
      expect((await apiError(trial(account.id, fx.product.id))).status).toBe(404);
    } finally {
      await db.product.update({ where: { id: fx.product.id }, data: { status: "PUBLISHED" } });
    }
  });
});
