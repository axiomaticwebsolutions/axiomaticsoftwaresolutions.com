import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { LICENSE_KEY_RE } from "@/lib/licensing/keys";
import { resolveOrderAccessFor } from "@/lib/orders/access";
import { buildOrderStatus } from "@/lib/orders/status";
import { authOf, makeCustomer, markPaid, placeOrder, seedCatalog, uniq, type CatalogFixture, type CustomerFixture } from "./checkout-fixtures";

let cat: CatalogFixture;
let owner: CustomerFixture;

beforeAll(async () => {
  cat = await seedCatalog();
  owner = await makeCustomer({ role: "OWNER" });
});

const viaToken = (order: { orderId: string; orderToken: string }) =>
  resolveOrderAccessFor(order.orderId, { auth: null, token: order.orderToken });

describe("buildOrderStatus", () => {
  it("describes an unpaid guest order", async () => {
    const order = await placeOrder(null, {
      email: `${uniq("st")}@example.test`,
      items: [{ planId: cat.plans.annual.id, qty: 1 }, { planId: cat.plans.perUnit.id, qty: 2 }],
    });
    const dto = await buildOrderStatus(db, await viaToken(order));
    expect(dto).toMatchObject({
      id: order.orderId,
      status: "AWAITING_PAYMENT",
      failReason: null,
      paidAt: null,
      placeOfSupply: "Maharashtra",
      couponCode: null,
      invoice: null,
      licenses: [],
      canRetry: true,
      canClaim: true,
      provider: "mock",
      billing: { name: "Priya Sharma", city: "Pune", gstin: null },
    });
    expect(dto.items.map((i) => [i.planName, i.qty, i.kind, i.unitPricePaise])).toEqual([
      ["Annual license", 1, "NEW", 499_900],
      ["Per-terminal license", 2, "NEW", 299_900],
    ]);
    expect(dto.totals.totalPaise).toBe(dto.totals.taxablePaise + dto.totals.cgstPaise + dto.totals.sgstPaise + dto.totals.igstPaise);
  });

  it("delivers each key once to the purchaser, then masks it", async () => {
    const order = await placeOrder(null, { email: `${uniq("st")}@example.test` });
    await markPaid(order.orderId);
    const access = await viaToken(order);

    const first = await buildOrderStatus(db, access);
    expect(first.status).toBe("PAID");
    expect(first.licenses).toHaveLength(1);
    const lic = first.licenses[0];
    expect(lic?.key).toMatch(LICENSE_KEY_RE);
    expect(lic?.keyMasked).toMatch(/^[A-Z]{3}-••••-••••-••••-[A-Z2-9]{4}$/);
    expect(lic?.key?.slice(-4)).toBe(lic?.keyMasked.slice(-4));
    expect(lic).toMatchObject({ status: "active", planName: "Annual license", deviceLimit: 1 });
    expect(first.canRetry).toBe(false);

    const row = await db.license.findUniqueOrThrow({ where: { id: lic?.id ?? "" } });
    expect(row.keyDeliveredAt).not.toBeNull();
    expect(await db.licenseEvent.count({ where: { licenseId: row.id, type: "key_delivered" } })).toBe(1);

    const second = await buildOrderStatus(db, access);
    expect(second.licenses[0]?.key).toBeUndefined();
    expect(second.licenses[0]?.keyMasked).toBe(lic?.keyMasked);
    expect(await db.licenseEvent.count({ where: { licenseId: row.id, type: "key_delivered" } })).toBe(1);
  });

  it("delivers a key at most once under concurrent polls", async () => {
    const order = await placeOrder(null, { email: `${uniq("st")}@example.test` });
    await markPaid(order.orderId);
    const access = await viaToken(order);
    const results = await Promise.all([1, 2, 3, 4].map(() => buildOrderStatus(db, access)));
    expect(results.filter((r) => r.licenses[0]?.key !== undefined)).toHaveLength(1);
  });

  it("never delivers keys to non-purchasers or cross-site requests, and keeps them for the purchaser", async () => {
    const order = await placeOrder(owner);
    await markPaid(order.orderId);
    const viewer = await makeCustomer({ role: "VIEWER", accountId: owner.accountId });
    const asViewer = await buildOrderStatus(db, await resolveOrderAccessFor(order.orderId, { auth: authOf(viewer) }));
    expect(asViewer.licenses[0]?.key).toBeUndefined();
    expect(asViewer.canRetry).toBe(false);

    const ownerAccess = await resolveOrderAccessFor(order.orderId, { auth: authOf(owner) });
    const crossSite = await buildOrderStatus(db, ownerAccess, { allowKeyDelivery: false });
    expect(crossSite.licenses[0]?.key).toBeUndefined();

    const delivered = await buildOrderStatus(db, ownerAccess);
    expect(delivered.licenses[0]?.key).toMatch(LICENSE_KEY_RE);
    expect(delivered.canClaim).toBe(false);
  });

  it("does not deliver revoked licenses", async () => {
    const order = await placeOrder(null, { email: `${uniq("st")}@example.test` });
    await markPaid(order.orderId);
    await db.license.updateMany({ where: { orderId: order.orderId }, data: { status: "REVOKED", revokedAt: new Date() } });
    const dto = await buildOrderStatus(db, await viaToken(order));
    expect(dto.licenses[0]).toMatchObject({ status: "revoked" });
    expect(dto.licenses[0]?.key).toBeUndefined();
  });

  it("stops offering the claim once a verified user owns the email", async () => {
    const email = `${uniq("st")}@example.test`;
    const order = await placeOrder(null, { email });
    expect((await buildOrderStatus(db, await viaToken(order))).canClaim).toBe(true);
    await makeCustomer({ email, verified: false });
    expect((await buildOrderStatus(db, await viaToken(order))).canClaim).toBe(true);
    await db.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    expect((await buildOrderStatus(db, await viaToken(order))).canClaim).toBe(false);
  });
});
