/**
 * Admin license reads: list filters (derived status, product, devices, search by id / last 4 / pasted key / email /
 * device), sorts, stats, the drawer detail (masked key, origin, devices, merged history, orders), the list route for
 * every staff role and the audited CSV export (reports.export).
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

import * as exportRoute from "@/app/api/admin/licenses/export.csv/route";
import * as detailRoute from "@/app/api/admin/licenses/[id]/route";
import * as listRoute from "@/app/api/admin/licenses/route";
import { suspendLicense } from "@/lib/admin/licenses/actions";
import type { LicenseListQuery } from "@/lib/admin/licenses/model";
import { adminLicenseStats, getAdminLicenseDetail, listAdminLicenses } from "@/lib/admin/licenses/queries";
import { actorFromStaff } from "@/lib/audit";
import { db } from "@/lib/db";
import { maskLicenseKey } from "@/lib/licensing/keys";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers } from "../support/admin-fixtures";
import { DAY, makeCatalog, makeDevice, makeLicense, makeMember, type Catalog, type Member } from "./license-actions-fixtures";

const NOW = new Date();
let callers: AdminCallers;
let catalog: Catalog;
let member: Member;
const L: Record<string, { id: string; key: string; keyLast4: string }> = {};

function query(over: Partial<LicenseListQuery> = {}): LicenseListQuery {
  return { q: "", filters: { product: catalog.product.id }, sort: { id: "issued", desc: true }, page: 1, pageSize: 25, ...over };
}

beforeAll(async () => {
  [callers, catalog] = await Promise.all([makeAdminCallers(), makeCatalog()]);
  member = await makeMember();
  const make = async (name: string, opts: Parameters<typeof makeLicense>[1]) => {
    const { license, key } = await makeLicense(catalog, opts);
    L[name] = { id: license.id, key, keyLast4: license.keyLast4 };
  };
  const acct = member.accountId;
  await make("active", { accountId: acct, expiresAt: new Date(NOW.getTime() + 200 * DAY), issuedAt: new Date(NOW.getTime() - 10 * DAY), deviceLimit: 2 });
  await make("expiring", { accountId: acct, expiresAt: new Date(NOW.getTime() + 20 * DAY), issuedAt: new Date(NOW.getTime() - 20 * DAY) });
  await make("expired", { accountId: acct, expiresAt: new Date(NOW.getTime() - 5 * DAY), issuedAt: new Date(NOW.getTime() - 30 * DAY) });
  await make("trial", { accountId: acct, plan: catalog.trial, status: "TRIAL", expiresAt: new Date(NOW.getTime() + 10 * DAY), deviceLimit: 1 });
  await make("suspended", { accountId: acct, status: "SUSPENDED" });
  await make("revoked", { accountId: acct, status: "REVOKED" });
  await make("perpetual", { accountId: acct, plan: catalog.oneTime, expiresAt: null, updatesUntil: new Date(NOW.getTime() + 100 * DAY) });
  await makeDevice(L.active!.id, { name: `Billing desk ${randomBytes(3).toString("hex")}` });
  await makeDevice(L.active!.id);
  await makeDevice(L.trial!.id);
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("listAdminLicenses", () => {
  it("lists the product's licenses with masked keys and device counts", async () => {
    const list = await listAdminLicenses(db, query(), NOW);
    expect(list.total).toBe(7);
    const active = list.items.find((r) => r.id === L.active!.id)!;
    expect(active).toMatchObject({ status: "active", devicesUsed: 2, deviceLimit: 2, customerEmail: member.user.email });
    expect(active.keyMasked).toBe(maskLicenseKey(catalog.product.code, L.active!.keyLast4));
    expect(JSON.stringify(list)).not.toContain(L.active!.key);
  });

  it("filters by derived status and devices", async () => {
    const by = async (filters: LicenseListQuery["filters"]) => ids((await listAdminLicenses(db, query({ filters: { product: catalog.product.id, ...filters } }), NOW)).items);
    expect(await by({ status: "active" })).toEqual(ids([L.active!, L.perpetual!]));
    expect(await by({ status: "expiring" })).toEqual([L.expiring!.id]);
    expect(await by({ status: "expired" })).toEqual([L.expired!.id]);
    expect(await by({ status: "trial" })).toEqual([L.trial!.id]);
    expect(await by({ status: "suspended" })).toEqual([L.suspended!.id]);
    expect(await by({ status: "revoked" })).toEqual([L.revoked!.id]);
    expect(await by({ devices: "full" })).toEqual(ids([L.active!, L.trial!]));
    expect((await by({ devices: "none" })).length).toBe(5);
  });

  it("searches by license id, last 4 of the key, a pasted full key, a member email and a device name", async () => {
    const search = async (q: string) => ids((await listAdminLicenses(db, query({ q }), NOW)).items);
    expect(await search(L.expired!.id)).toEqual([L.expired!.id]);
    expect(await search(L.trial!.keyLast4)).toContain(L.trial!.id);
    expect(await search(L.suspended!.key)).toEqual([L.suspended!.id]);
    expect((await search(member.user.email)).length).toBe(7);
    const device = await db.deviceActivation.findFirstOrThrow({ where: { licenseId: L.active!.id, name: { startsWith: "Billing desk" } } });
    expect(await search(device.name)).toEqual([L.active!.id]);
    expect(await search("no-such-license-anywhere")).toEqual([]);
  });

  it("sorts by expiry with perpetual licenses last ascending, and by device use", async () => {
    const asc = (await listAdminLicenses(db, query({ sort: { id: "expires", desc: false } }), NOW)).items.map((r) => r.id);
    expect(asc.at(-1)).toBe(L.perpetual!.id);
    expect(asc.indexOf(L.expired!.id)).toBeLessThan(asc.indexOf(L.expiring!.id));
    const byDevices = (await listAdminLicenses(db, query({ sort: { id: "devices", desc: true } }), NOW)).items.map((r) => r.id);
    expect(byDevices.slice(0, 2).sort()).toEqual(ids([L.active!, L.trial!]));
    const page2 = await listAdminLicenses(db, query({ pageSize: 3, page: 3 }), NOW);
    expect(page2.items).toHaveLength(1);
    expect(page2.total).toBe(7);
  });

  it("counts stats across all licenses", async () => {
    const before = await adminLicenseStats(db, NOW);
    await makeLicense(catalog, { accountId: member.accountId, expiresAt: new Date(NOW.getTime() + 300 * DAY) });
    await makeLicense(catalog, { accountId: member.accountId, status: "REVOKED" });
    const after = await adminLicenseStats(db, NOW);
    expect(after.active - before.active).toBe(1);
    expect(after.suspendedOrRevoked - before.suspendedOrRevoked).toBe(1);
    expect(after.expiring).toBe(before.expiring);
  });
});

describe("getAdminLicenseDetail", () => {
  it("returns terms, masked key, origin and devices (active first) without the full key", async () => {
    const detail = await getAdminLicenseDetail(db, L.active!.id, NOW);
    expect(detail).not.toBeNull();
    expect(detail!).toMatchObject({
      id: L.active!.id,
      status: "active",
      storedStatus: "ACTIVE",
      origin: "Issued by staff",
      devicesUsed: 2,
      devicesTotal: 2,
      deviceLimit: 2,
      contactEmail: member.user.email,
      businessName: expect.any(String),
      selfServiceResetsUsed: 0,
      selfServiceResetsPerYear: 3,
      renewalValuePaise: catalog.annual.pricePaise,
    });
    expect(detail!.keyMasked).toBe(maskLicenseKey(catalog.product.code, L.active!.keyLast4));
    expect(detail!.devices.every((d) => d.fingerprintShort.length === 10)).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(L.active!.key);
    expect((await getAdminLicenseDetail(db, L.trial!.id, NOW))!.origin).toBe("Trial");
    expect(await getAdminLicenseDetail(db, "LIC-UNKNOWN0", NOW)).toBeNull();
  });

  it("shows a staff action once in History, with the staff member and the reason", async () => {
    const { license } = await makeLicense(catalog, { accountId: member.accountId });
    await db.licenseEvent.create({ data: { licenseId: license.id, type: "issued", actor: "System", detail: "Order AX-1", createdAt: new Date(NOW.getTime() - 60 * DAY) } });
    const staff = callers.SUPPORT.user;
    await suspendLicense(license.id, { staff: { id: staff.id, name: staff.name, role: "SUPPORT" }, actor: actorFromStaff(staff), input: { reason: "Chargeback opened" } });
    const detail = (await getAdminLicenseDetail(db, license.id, new Date()))!;
    expect(detail.status).toBe("suspended");
    expect(detail.history.map((h) => h.label)).toEqual(["Suspended license", "License issued"]);
    expect(detail.history[0]?.by).toBe(`${staff.name} \u00B7 Chargeback opened`);
    expect(detail.history[1]?.by).toBe("System \u00B7 Order AX-1");
  });

  it("lists the issuing order and orders that renewed the license", async () => {
    const tag = randomBytes(3).toString("hex").toUpperCase();
    const order = (id: string, kind: "NEW" | "RENEWAL", licenseId: string | null) =>
      db.order.create({
        data: {
          id,
          accountId: member.accountId,
          email: member.user.email,
          billing: {},
          status: "PAID",
          subtotalPaise: 600_000,
          taxablePaise: 600_000,
          totalPaise: 708_000,
          placeOfSupply: "Maharashtra",
          paidAt: new Date(),
          items: { create: [{ planId: catalog.annual.id, kind, unitPricePaise: 600_000, taxablePaise: 600_000, taxPaise: 108_000, targetLicenseId: licenseId }] },
        },
      });
    await order(`AX-Q${tag}1`, "NEW", null);
    const { license } = await makeLicense(catalog, { accountId: member.accountId });
    await db.license.update({ where: { id: license.id }, data: { orderId: `AX-Q${tag}1` } });
    await order(`AX-Q${tag}2`, "RENEWAL", license.id);
    const detail = (await getAdminLicenseDetail(db, license.id, NOW))!;
    expect(detail.origin).toBe(`Order AX-Q${tag}1`);
    expect(detail.orders.map((o) => [o.id, o.kind]).sort()).toEqual([[`AX-Q${tag}1`, "New"], [`AX-Q${tag}2`, "Renewal"]]);
  });
});

describe("routes", () => {
  it("lists for every staff role (Finance reads) and refuses customers", async () => {
    for (const session of [callers.FINANCE, callers.SUPPORT]) {
      const res = await callRoute(jar, listRoute.GET, { path: `/api/admin/licenses?filter[product]=${catalog.product.id}&pageSize=2&sort=id`, session });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { items: unknown[]; total: number; page: number; pageSize: number };
      expect(body).toMatchObject({ page: 1, pageSize: 2 });
      expect(body.items).toHaveLength(2);
      expect(body.total).toBeGreaterThanOrEqual(7);
    }
    expect((await callRoute(jar, listRoute.GET, { path: "/api/admin/licenses", session: callers.customer })).status).toBe(403);
  });

  it("answers 404 for an unknown license and serves the drawer otherwise", async () => {
    const missing = await callRoute(jar, detailRoute.GET, { path: "/api/admin/licenses/LIC-NONE0000", params: { id: "LIC-NONE0000" }, session: callers.FINANCE });
    expect(missing.status).toBe(404);
    expect(await errorCodeOf(missing)).toBe("not_found");
    const ok = await callRoute(jar, detailRoute.GET, { path: `/api/admin/licenses/${L.expiring!.id}`, params: { id: L.expiring!.id }, session: callers.FINANCE });
    expect(((await ok.json()) as { license: { status: string } }).license.status).toBe("expiring");
  });

  it("exports CSV for Owner and Finance only, with an audit row", async () => {
    const path = `/api/admin/licenses/export.csv?filter[product]=${catalog.product.id}`;
    expect((await callRoute(jar, exportRoute.GET, { path, session: callers.SUPPORT })).status).toBe(403);
    const before = await db.auditLog.count({ where: { action: "Exported report", target: "Licenses", actorId: callers.FINANCE.user.id } });
    const res = await callRoute(jar, exportRoute.GET, { path, session: callers.FINANCE });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain(L.active!.id);
    expect(csv).not.toContain(L.active!.key);
    expect(Number(res.headers.get("x-row-count"))).toBeGreaterThanOrEqual(7);
    const after = await db.auditLog.count({ where: { action: "Exported report", target: "Licenses", actorId: callers.FINANCE.user.id } });
    expect(after - before).toBe(1);
  });
});
