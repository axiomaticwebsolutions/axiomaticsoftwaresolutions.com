/**
 * GET /api/account/overview on a constructed account: KPIs, alerts, utilisation, renewal timeline, spend by product
 * (PAID in full, PARTIALLY_REFUNDED net of refunds, REFUNDED/unpaid excluded) and recent activity (Owner only).
 * Another account's licenses, orders and tickets never count (IDOR).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Order } from "@/generated/prisma/client";
import { GET as overviewGET } from "@/app/api/account/overview/route";
import { db } from "@/lib/db";
import { financialYearStart, type AccountOverview } from "@/lib/portal/overview";
import {
  addPayment,
  bodyOf,
  call,
  DAY,
  errorOf,
  makeActivity,
  makeCatalog,
  makeDevice,
  makeLicense,
  makeMember,
  makeOrder,
  makeTicket,
  signIn,
  type Catalog,
  type Member,
} from "./portal-api-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: { maxAge?: number } = {}) => {
      if (options.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

const now = Date.now();
const at = (days: number) => new Date(now + days * DAY);

let A: Catalog;
let B: Catalog;
let C: Catalog;
let owner: Member;
let viewer: Member;
let L: Record<"full" | "soon" | "later" | "expired" | "trial" | "revoked" | "perpetual", string>;
let paidRecent: Order;
let partial: Order;

beforeAll(async () => {
  A = await makeCatalog();
  B = await makeCatalog();
  C = await makeCatalog();
  owner = await makeMember({ name: "Priya Sharma" });
  viewer = await makeMember({ accountId: owner.accountId, role: "VIEWER", name: "Asha Viewer" });
  const lic = async (c: Catalog, opts: Parameters<typeof makeLicense>[1]) => (await makeLicense(c, opts)).license.id;
  L = {
    full: await lic(A, { accountId: owner.accountId, expiresAt: at(200), deviceLimit: 2 }),
    soon: await lic(A, { accountId: owner.accountId, expiresAt: at(20), deviceLimit: 3 }),
    later: await lic(A, { accountId: owner.accountId, expiresAt: at(100), deviceLimit: 3 }),
    expired: await lic(B, { accountId: owner.accountId, expiresAt: at(-5), deviceLimit: 1 }),
    trial: await lic(A, { accountId: owner.accountId, plan: A.trial, status: "TRIAL", expiresAt: at(10), deviceLimit: 1 }),
    revoked: await lic(A, { accountId: owner.accountId, status: "REVOKED", expiresAt: at(100) }),
    perpetual: await lic(C, { accountId: owner.accountId, plan: C.oneTime, expiresAt: null, updatesUntil: at(-30), deviceLimit: 1 }),
  };
  await makeDevice(L.full);
  await makeDevice(L.full);
  await makeDevice(L.full, { deactivatedAt: at(-3) });
  await makeDevice(L.soon);
  await db.release.createMany({
    data: [
      { productId: C.product.id, version: "4.0.0", status: "PUBLISHED", releasedAt: at(-60), notes: [] },
      { productId: C.product.id, version: "5.0.0", status: "PUBLISHED", releasedAt: at(-10), notes: [] },
      { productId: C.product.id, version: "6.0.0-beta.1", channel: "beta", status: "PUBLISHED", releasedAt: at(-2), notes: [] },
    ],
  });

  paidRecent = await makeOrder({ accountId: owner.accountId, createdAt: at(-10), lines: [{ plan: A.annual, taxablePaise: 600_000, taxPaise: 108_000 }] });
  await makeOrder({ accountId: owner.accountId, createdAt: at(-400), lines: [{ plan: B.annual, taxablePaise: 100_000, taxPaise: 18_000 }] });
  partial = await makeOrder({
    accountId: owner.accountId,
    status: "PARTIALLY_REFUNDED",
    createdAt: at(-5),
    lines: [
      { plan: A.annual, taxablePaise: 300_000, taxPaise: 54_000 },
      { plan: C.oneTime, taxablePaise: 200_000, taxPaise: 36_000 },
    ],
  });
  await addPayment(partial.id, 590_000, { refundedPaise: 118_000 });
  await makeOrder({ accountId: owner.accountId, status: "REFUNDED", createdAt: at(-3), lines: [{ plan: A.annual, taxablePaise: 1_000_000, taxPaise: 180_000 }] });
  await makeOrder({ accountId: owner.accountId, status: "AWAITING_PAYMENT", createdAt: at(-1), lines: [{ plan: A.annual, taxablePaise: 900_000, taxPaise: 162_000 }] });

  await makeTicket(owner.accountId, { status: "AWAITING_CUSTOMER", subject: "Older waiting", updatedAt: at(-4) });
  await makeTicket(owner.accountId, { status: "AWAITING_CUSTOMER", subject: "Newest waiting", updatedAt: at(-1) });
  await makeTicket(owner.accountId, { status: "OPEN" });
  for (let i = 0; i < 7; i++) await makeActivity(owner.accountId, { action: `Action ${i}`, at: at(-10 + i) });
  await makeActivity(owner.accountId, { action: "Too old", at: at(-800) });

  // Another account with a full license, a big paid order and a waiting ticket: none of it may show up.
  const stranger = await makeMember({ name: "Other Owner" });
  const foreign = (await makeLicense(A, { accountId: stranger.accountId, expiresAt: at(5), deviceLimit: 1 })).license.id;
  await makeDevice(foreign);
  await makeOrder({ accountId: stranger.accountId, createdAt: at(-2), lines: [{ plan: A.annual, taxablePaise: 5_000_000, taxPaise: 900_000 }] });
  await makeTicket(stranger.accountId, { status: "AWAITING_CUSTOMER" });
  await makeOrder({ accountId: null, createdAt: at(-2), lines: [{ plan: A.annual, taxablePaise: 7_000_000, taxPaise: 1_260_000 }] });
});

const overviewAs = async (member: Member) => {
  await signIn(jar, member);
  const res = await call(jar, overviewGET, "/api/account/overview");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as AccountOverview;
};

describe("GET /api/account/overview", () => {
  it("computes KPIs from the account's own licenses, devices and paid orders", async () => {
    const o = await overviewAs(owner);
    expect(o.account).toEqual({ id: owner.accountId, legalName: expect.any(String) });
    expect(o.kpis.licenses).toEqual({ active: 5, total: 7, inactive: 2 });
    expect(o.kpis.deviceSlots).toEqual({ used: 3, slots: 10, pct: 30, licenses: 5 });
    const fyStart = financialYearStart(new Date()).getTime();
    const inFy = [
      [paidRecent.paidAt, 708_000],
      [partial.paidAt, 472_000],
    ].reduce((sum, [paidAt, amount]) => sum + ((paidAt as Date).getTime() >= fyStart ? (amount as number) : 0), 0);
    expect(o.kpis.spend).toEqual({
      allTimePaise: 708_000 + 118_000 + 472_000,
      last12MonthsPaise: 708_000 + 472_000,
      thisFyPaise: inFy,
      fyLabel: expect.stringMatching(/^\d{2}-\d{2}$/),
    });
    expect(o.kpis.nextRenewal).toEqual({ licenseId: L.soon, productShortName: "Medical", expiresAt: at(20).toISOString(), days: 20 });
  });

  it("raises one alert per kind, most urgent first, with renewal cart lines", async () => {
    const o = await overviewAs(owner);
    expect(o.alerts.map((a) => a.kind)).toEqual(["expiring", "expired", "updates_ended", "ticket_waiting", "device_limit"]);
    const [expiring, expired, updates, waiting, full] = o.alerts;
    expect(expiring).toMatchObject({
      title: "Medical ends in 20 days.",
      body: `Renew ${L.soon} to keep billing without interruption.`,
      licenseId: L.soon,
      more: 0,
      cta: { label: "Renew now", renewal: { tag: "RENEWAL", kind: "RENEWAL", planId: A.annual.id, qty: 1, pricePaise: 600_000 } },
    });
    expect(expired).toMatchObject({ licenseId: L.expired, cta: { label: "Renew now", renewal: { planId: B.annual.id } } });
    expect(updates).toMatchObject({
      licenseId: L.perpetual,
      body: `Version 5.0.0 is out. Renew maintenance for ${L.perpetual} to download it.`,
      cta: { label: "Renew maintenance", renewal: { tag: "MAINTENANCE", planId: C.amc.id } },
    });
    expect(waiting).toMatchObject({ title: "Support is waiting for your reply.", more: 1 });
    expect(waiting?.body).toContain("Newest waiting");
    expect(full).toMatchObject({ licenseId: L.full, title: `${L.full} has no free device slots.`, more: 0 });
  });

  it("lists slot utilisation, the 12-month renewal timeline and spend by product", async () => {
    const o = await overviewAs(owner);
    expect(o.utilization.rows.map((r) => [r.licenseId, r.used, r.limit, r.full])).toEqual([
      [L.full, 2, 2, true],
      [L.soon, 1, 3, false],
      ...[L.later, L.trial, L.perpetual].sort().map((id) => [id, 0, id === L.later ? 3 : 1, false]),
    ]);
    expect(o.renewals.months).toHaveLength(12);
    expect(o.renewals.items.map((i) => [i.licenseId, i.days, i.soon, i.renewal?.tag])).toEqual([
      [L.soon, 20, true, "RENEWAL"],
      [L.later, 100, false, "RENEWAL"],
      [L.full, 200, false, "RENEWAL"],
    ]);
    for (const item of o.renewals.items) {
      expect(item.positionPct).toBeGreaterThanOrEqual(2);
      expect(item.positionPct).toBeLessThanOrEqual(98);
    }
    expect(o.spendByProduct.map((s) => [s.productId, s.amountPaise, s.barPct])).toEqual([
      [A.product.id, 708_000 + 283_200, 100],
      [C.product.id, 188_800, 19],
      [B.product.id, 118_000, 11.9],
    ]);
  });

  it("shows recent activity to the Owner only", async () => {
    const o = await overviewAs(owner);
    expect(o.recentActivity?.map((a) => a.action)).toEqual(["Action 6", "Action 5", "Action 4", "Action 3", "Action 2", "Action 1"]);
    const v = await overviewAs(viewer);
    expect(v.recentActivity).toBeNull();
    expect(v.kpis.licenses).toEqual({ active: 5, total: 7, inactive: 2 });
  });

  it("needs a signed-in member with a verified email", async () => {
    jar.clear();
    expect((await call(jar, overviewGET, "/api/account/overview")).status).toBe(401);
    const unverified = await makeMember({ verified: false });
    await signIn(jar, unverified);
    const res = await call(jar, overviewGET, "/api/account/overview");
    expect(res.status).toBe(403);
    expect(errorOf(await bodyOf(res)).code).toBe("email_unverified");
  });

  it("shows an empty account without alerts", async () => {
    const empty = await makeMember();
    const o = await overviewAs(empty);
    expect(o.alerts).toEqual([]);
    expect(o.kpis).toMatchObject({
      licenses: { active: 0, total: 0, inactive: 0 },
      deviceSlots: { used: 0, slots: 0, pct: null, licenses: 0 },
      spend: { allTimePaise: 0, last12MonthsPaise: 0, thisFyPaise: 0 },
      nextRenewal: null,
    });
    expect(o.renewals.items).toEqual([]);
    expect(o.spendByProduct).toEqual([]);
    expect(o.recentActivity).toEqual([]);
  });
});
