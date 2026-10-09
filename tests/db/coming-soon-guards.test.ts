/**
 * A COMING_SOON product is never sold (decisions.md 2026-10-09): quotes, orders, pending payments, renewals, trials,
 * manual issue, activation and downloads all refuse it, even when the admin has already added plans, a release or (by
 * hand) a license to it ahead of the launch.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

import type { Plan } from "@/generated/prisma/client";
import * as licensesRoute from "@/app/api/admin/licenses/route";
import { manualIssuePlanOptions } from "@/lib/admin/licenses/queries";
import { adminOrderPlanOptions } from "@/lib/admin/orders/queries";
import { assertOrderStillPurchasable } from "@/lib/checkout/payment-attempt";
import { priceCart, toQuoteDto } from "@/lib/checkout/quote";
import { db } from "@/lib/db";
import { issueDownload } from "@/lib/downloads/issue";
import { renewalOptionsFor, type RenewalLicense, type RenewalPlan } from "@/lib/licensing/account";
import { activateLicense } from "@/lib/licensing/activation";
import { issueLicense, startTrial } from "@/lib/licensing/issue";
import type { StorageDriver } from "@/lib/storage";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers } from "../support/admin-fixtures";
import { freshProductCode } from "../support/product-codes";
import { activationInput, newFingerprint, nextIp } from "./activation-fixtures";
import { buyerOf, makeCustomer, placeOrder, uniq, type CustomerFixture } from "./checkout-fixtures";

const DAY = 86_400_000;
const storage: StorageDriver = {
  kind: "s3",
  presignGet: async () => ({ url: "https://bucket.example/x", expiresAt: new Date(Date.now() + 600_000) }),
  presignPut: async () => {
    throw new Error("unused");
  },
  head: async () => null,
  delete: async () => undefined,
  putObject: async () => undefined,
};

const f = {} as { productId: string; code: string; annual: Plan; trial: Plan; licenseId: string; key: string; fileId: string };
let owner: CustomerFixture;
let callers: AdminCallers;

beforeAll(async () => {
  callers = await makeAdminCallers();
  owner = await makeCustomer({ role: "OWNER" });
  const category = await db.category.create({ data: { id: uniq("cscat"), name: "Coming soon test", tone: "pink", icon: "diamond" } });
  f.productId = uniq("csprod");
  f.code = await freshProductCode();
  await db.product.create({
    data: {
      id: f.productId, code: f.code, name: "Coming Soon Test Software", shortName: "Coming Soon Test", tagline: "t", summary: "t",
      icon: "diamond", categoryId: category.id, platforms: ["windows"], status: "PUBLISHED", content: {}, relatedIds: [],
    },
  });
  // Plans and a release prepared ahead of the launch, and one license issued before it was switched to COMING_SOON.
  f.annual = await db.plan.create({ data: { id: uniq("csplan"), productId: f.productId, type: "ANNUAL", name: "Annual", pricePaise: 299_900, interval: "YEAR", deviceLimit: 1, includes: [] } });
  f.trial = await db.plan.create({ data: { id: uniq("cstrial"), productId: f.productId, type: "TRIAL", name: "Trial", pricePaise: 0, trialDays: 15, deviceLimit: 1, includes: [] } });
  const issued = await db.$transaction((tx) =>
    issueLicense(tx, { accountId: owner.accountId, product: { id: f.productId, code: f.code }, plan: f.annual, qty: 1, at: new Date(), actor: "System" }),
  );
  f.licenseId = issued.license.id;
  f.key = issued.key;
  const release = await db.release.create({ data: { productId: f.productId, version: "1.0.0", status: "PUBLISHED", releasedAt: new Date(Date.now() - DAY), notes: [] } });
  f.fileId = (
    await db.releaseFile.create({
      data: { releaseId: release.id, platform: "windows", fileName: "CS-1.0.0-setup.exe", storageKey: `releases/${f.productId}/1.0.0/CS-1.0.0-setup.exe`, sizeBytes: BigInt(1024), sha256: "0".repeat(64) },
    })
  ).id;
});

const comingSoon = () => db.product.update({ where: { id: f.productId }, data: { status: "COMING_SOON" } });

describe("COMING_SOON products are never sold", () => {
  it("a pending order placed while it was published can no longer be paid", async () => {
    const order = await placeOrder(owner, { items: [{ planId: f.annual.id, qty: 1 }] });
    await comingSoon();
    await expect(assertOrderStillPurchasable(db, order.orderId, owner.accountId)).rejects.toMatchObject({ status: 409, code: "order_unavailable" });
  });

  it("quotes refuse new purchases and renewals of it", async () => {
    const items = [
      { planId: f.annual.id, qty: 1 },
      { planId: f.annual.id, qty: 1, kind: "RENEWAL" as const, targetLicenseId: f.licenseId },
    ];
    const quote = toQuoteDto(await priceCart(db, { items }, await buyerOf(owner), new Date()));
    expect(quote.issues.map((i) => [i.index, i.code])).toEqual([[0, "unavailable"], [1, "unavailable"]]);
    expect(quote.lines).toEqual([]);
  });

  it("checkout creates no order for it", async () => {
    const before = await db.order.count();
    await expect(placeOrder(owner, { items: [{ planId: f.annual.id, qty: 1 }] })).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await db.order.count()).toBe(before);
  });

  it("offers no renewal, upgrade or add-on in the portal", () => {
    const plan: RenewalPlan = { id: f.annual.id, name: "Annual", type: "ANNUAL", interval: "YEAR", pricePaise: 299_900, perUnit: null, maxQty: null, multiDevice: false, archived: false, sortOrder: 0 };
    const license: RenewalLicense = { status: "ACTIVE", expiresAt: new Date(Date.now() + 30 * DAY), updatesUntil: new Date(Date.now() + 30 * DAY), deviceLimit: 1, plan, productStatus: "COMING_SOON" };
    expect(renewalOptionsFor(license, [plan], new Date())).toEqual([]);
    expect(renewalOptionsFor({ ...license, productStatus: "HIDDEN" }, [plan], new Date()).length).toBeGreaterThan(0);
  });

  it("starts no trial", async () => {
    const other = await makeCustomer({ role: "OWNER" });
    const user = { id: other.user.id, name: "Priya", emailVerifiedAt: new Date() };
    await expect(db.$transaction((tx) => startTrial(tx, { accountId: other.accountId, productId: f.productId, user, at: new Date() }))).rejects.toMatchObject({ status: 404 });
    expect(await db.license.count({ where: { productId: f.productId, accountId: other.accountId } })).toBe(0);
  });

  it("issues no license by hand", async () => {
    const before = await db.license.count({ where: { productId: f.productId } });
    const res = await callRoute(jar, licensesRoute.POST, {
      method: "POST",
      path: "/api/admin/licenses",
      params: {},
      session: callers.OWNER,
      body: { accountId: owner.accountId, planId: f.annual.id, reason: "Early access" },
    });
    expect(res.status).toBe(422);
    expect(await errorCodeOf(res)).toBe("validation_failed");
    expect(await db.license.count({ where: { productId: f.productId } })).toBe(before);
  });

  it("offers none of its plans in the staff forms (manual issue, new order)", async () => {
    await comingSoon();
    expect((await manualIssuePlanOptions(db)).some((p) => p.productId === f.productId)).toBe(false);
    expect((await adminOrderPlanOptions(db)).some((p) => p.productId === f.productId)).toBe(false);
    await db.product.update({ where: { id: f.productId }, data: { status: "HIDDEN" } });
    try {
      expect((await manualIssuePlanOptions(db)).some((p) => p.id === f.annual.id)).toBe(true);
      expect((await adminOrderPlanOptions(db)).some((p) => p.id === f.annual.id)).toBe(true);
    } finally {
      await comingSoon();
    }
  });

  it("activates no key of it (the app is told the key is not valid)", async () => {
    await expect(activateLicense(activationInput(f.key, newFingerprint()), { appId: f.code, ip: nextIp() })).rejects.toMatchObject({ status: 404, code: "invalid_key" });
    expect(await db.deviceActivation.count({ where: { licenseId: f.licenseId } })).toBe(0);
  });

  it("offers no download of its releases", async () => {
    const input = { fileId: f.fileId, scope: { kind: "account" as const, accountId: owner.accountId }, eventUserId: owner.user.id, actorName: "Priya", ttlSec: 600, storage };
    await expect(issueDownload(db, input)).rejects.toMatchObject({ status: 403, code: "not_entitled" });
    expect(await db.downloadEvent.count({ where: { fileId: f.fileId } })).toBe(0);
  });
});
