/**
 * GET /api/account/licenses, /api/account/licenses/:id and /api/account/devices: account scoping (IDOR), filters,
 * sorting, masked keys, history, renewal options and the device fleet stats.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as devicesGET } from "@/app/api/account/devices/route";
import { GET as licenseGET } from "@/app/api/account/licenses/[id]/route";
import { GET as licensesGET } from "@/app/api/account/licenses/route";
import { db } from "@/lib/db";
import { maskLicenseKey } from "@/lib/licensing/keys";
import {
  bodyOf,
  call,
  DAY,
  errorOf,
  makeCatalog,
  makeDevice,
  makeLicense,
  makeLocation,
  makeMember,
  signIn,
  type Catalog,
  type Member,
} from "./license-actions-fixtures";

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

type Row = { id: string; status: string; keyMasked: string; devicesUsed: number; productId: string };
const now = Date.now();
const at = (days: number) => new Date(now + days * DAY);

let catalog: Catalog;
let other: Catalog;
let owner: Member;
let L: Record<"active" | "expiring" | "expired" | "trial" | "revoked" | "perpetual", { id: string; key: string }>;
let foreignLicense: { id: string; key: string };

beforeAll(async () => {
  catalog = await makeCatalog();
  other = await makeCatalog();
});
beforeEach(async () => {
  owner = await makeMember();
  const mk = async (opts: Parameters<typeof makeLicense>[1], c: Catalog = catalog) => {
    const { license, key } = await makeLicense(c, opts);
    return { id: license.id, key };
  };
  L = {
    active: await mk({ accountId: owner.accountId, expiresAt: at(200) }),
    expiring: await mk({ accountId: owner.accountId, expiresAt: at(20) }),
    expired: await mk({ accountId: owner.accountId, expiresAt: at(-5) }),
    trial: await mk({ accountId: owner.accountId, plan: catalog.trial, status: "TRIAL", expiresAt: at(10), deviceLimit: 1 }),
    revoked: await mk({ accountId: owner.accountId, status: "REVOKED", expiresAt: at(100) }),
    perpetual: await mk({ accountId: owner.accountId, plan: other.oneTime, expiresAt: null, updatesUntil: at(-30), deviceLimit: 1 }, other),
  };
  await db.license.update({ where: { id: L.revoked.id }, data: { revokedReason: "Refunded order.", revokedAt: at(-1) } });
  const stranger = await makeMember({ name: "Other Owner" });
  foreignLicense = await mk({ accountId: stranger.accountId });
  await makeDevice(foreignLicense.id, { name: "Stranger PC" });
  await signIn(jar, owner);
});

const list = async (query = "") => {
  const res = await call(jar, licensesGET, `/api/account/licenses${query}`);
  return { res, body: await bodyOf(res) };
};
const ids = (body: Record<string, unknown>) => (body.licenses as Row[]).map((r) => r.id);

describe("GET /api/account/licenses", () => {
  it("lists only the account's licenses, masked, sorted by end date (perpetual last)", async () => {
    const { res, body } = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(ids(body)).toEqual([L.expired.id, L.trial.id, L.expiring.id, L.revoked.id, L.active.id, L.perpetual.id]);
    expect(body.total).toBe(6);
    expect(body.truncated).toBe(false);
    expect((body.products as Array<{ id: string }>).map((p) => p.id).sort()).toEqual([catalog.product.id, other.product.id].sort());
    const text = JSON.stringify(body);
    for (const l of [...Object.values(L), foreignLicense]) expect(text).not.toContain(l.key);
    expect(text).not.toContain(foreignLicense.id);
    const first = (body.licenses as Row[])[0]!;
    expect(first.keyMasked).toBe(maskLicenseKey(catalog.product.code, L.expired.key.slice(-4)));
  });

  it("filters by derived status, product and search", async () => {
    const statuses = (body: Record<string, unknown>) => (body.licenses as Row[]).map((r) => r.status);
    for (const status of ["active", "expiring", "expired", "trial", "revoked"] as const) {
      const { body } = await list(`?status=${status}`);
      expect(statuses(body).every((s) => s === status), status).toBe(true);
    }
    expect(ids((await list("?status=active")).body).sort()).toEqual([L.active.id, L.perpetual.id].sort());
    expect(ids((await list("?status=suspended")).body)).toEqual([]);
    expect(ids((await list(`?product=${other.product.id}`)).body)).toEqual([L.perpetual.id]);
    expect(ids((await list(`?q=${L.trial.id.toLowerCase()}`)).body)).toEqual([L.trial.id]);
    expect(ids((await list(`?q=${L.revoked.key.slice(-4).toLowerCase()}`)).body)).toContain(L.revoked.id);
    expect(ids((await list(`?q=${encodeURIComponent(other.product.name.slice(0, 12))}&status=all`)).body)).toContain(L.perpetual.id);
    const { body } = await list(`?q=${foreignLicense.id}`);
    expect(ids(body)).toEqual([]);
    expect(body.total).toBe(6);
  });

  it("sorts descending with a '-' prefix and rejects unknown parameters' values", async () => {
    expect(ids((await list("?sort=-expiry")).body)[0]).toBe(L.perpetual.id);
    const bad = await list("?status=gone");
    expect(bad.res.status).toBe(422);
    expect(errorOf(bad.body).code).toBe("validation_failed");
    expect((await list("?sort=price")).res.status).toBe(422);
  });

  it("is readable by every team role but needs a verified member", async () => {
    for (const role of ["VIEWER", "BILLING", "TECHNICAL"] as const) {
      await signIn(jar, await makeMember({ accountId: owner.accountId, role }));
      expect(ids((await list()).body), role).toHaveLength(6);
    }
    await signIn(jar, await makeMember({ verified: false }));
    const unverified = await list();
    expect(unverified.res.status).toBe(403);
    expect(errorOf(unverified.body).code).toBe("email_unverified");
    jar.clear();
    expect((await list()).res.status).toBe(401);
  });
});

const detail = async (id: string) => {
  const res = await call(jar, licenseGET, `/api/account/licenses/${id}`, { params: { id } });
  return { res, body: await bodyOf(res) };
};
type Detail = {
  license: Record<string, unknown>;
  devices: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
  renewalOptions: Array<Record<string, unknown>>;
  locations: Array<{ id: string; name: string }>;
};

describe("GET /api/account/licenses/:id", () => {
  it("returns terms, devices (active first), history (newest first) and renewal options", async () => {
    const shop = await makeLocation(owner.accountId, "FC Road (main store)");
    const counter = await makeDevice(L.active.id, { name: "Billing counter PC", locationId: shop.id, lastSeenAt: at(-0.1) });
    const laptop = await makeDevice(L.active.id, { name: "Back office laptop", lastSeenAt: at(-45) });
    const old = await makeDevice(L.active.id, { name: "Old counter PC", deactivatedAt: at(-60), lastSeenAt: at(-61) });
    await db.license.update({ where: { id: L.active.id }, data: { selfServiceResets: 1 } });
    await db.licenseEvent.createMany({
      data: [
        { licenseId: L.active.id, type: "issued", actor: "System", detail: "Order AX-1", createdAt: at(-100) },
        { licenseId: L.active.id, type: "activated", actor: "Device", detail: "Billing counter PC", createdAt: at(-90) },
        { licenseId: L.active.id, type: "deactivated", actor: "Priya Sharma", detail: "Old counter PC", createdAt: at(-60) },
      ],
    });

    const { res, body } = await detail(L.active.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const d = body as unknown as Detail;
    expect(d.license).toMatchObject({
      id: L.active.id,
      status: "active",
      keyMasked: maskLicenseKey(catalog.product.code, L.active.key.slice(-4)),
      planType: "ANNUAL",
      deviceLimit: 3,
      devicesUsed: 2,
      unit: "computer",
      selfServiceResetsLeft: 2,
      selfServiceResetsPerYear: 3,
      canReveal: true,
      canManageDevices: true,
      revokedReason: null,
    });
    expect(JSON.stringify(body)).not.toContain(L.active.key);
    expect(d.devices.map((x) => x.id)).toEqual([counter.id, laptop.id, old.id]);
    expect(d.devices[0]).toMatchObject({ active: true, stale: false, canDeactivate: true, locationName: "FC Road (main store)" });
    expect(d.devices[1]).toMatchObject({ active: true, stale: true, locationName: "Unassigned" });
    expect(d.devices[2]).toMatchObject({ active: false, canDeactivate: false });
    expect(d.history.map((h) => [h.label, h.actor, h.detail])).toEqual([
      ["Deactivated", "Priya Sharma", "Old counter PC"],
      ["Activated", "Device", "Billing counter PC"],
      ["License issued", "System", "Order AX-1"],
    ]);
    expect(d.renewalOptions.map((o) => o.tag)).toEqual(["RENEWAL", "ADD-ON", "UPGRADE"]);
    expect(d.renewalOptions[0]).toMatchObject({ kind: "RENEWAL", planId: catalog.annual.id, pricePaise: 600_000 });
    expect(d.locations).toEqual([{ id: shop.id, name: "FC Road (main store)" }]);
  });

  it("tailors permissions and options to the role and license", async () => {
    await signIn(jar, await makeMember({ accountId: owner.accountId, role: "VIEWER" }));
    await makeDevice(L.active.id, { name: "Counter" });
    const viewer = (await detail(L.active.id)).body as unknown as Detail;
    expect(viewer.license).toMatchObject({ canReveal: false, canManageDevices: false });
    expect(viewer.devices[0]).toMatchObject({ active: true, canDeactivate: false });

    await signIn(jar, owner);
    const revoked = (await detail(L.revoked.id)).body as unknown as Detail;
    expect(revoked.license).toMatchObject({ status: "revoked", revokedReason: "Refunded order.", canReveal: false, canManageDevices: false });
    expect(revoked.renewalOptions).toEqual([]);
    const trial = (await detail(L.trial.id)).body as unknown as Detail;
    expect(trial.renewalOptions.map((o) => [o.tag, o.kind])).toEqual([["BUY", "UPGRADE"]]);
    const perpetual = (await detail(L.perpetual.id)).body as unknown as Detail;
    expect(perpetual.license).toMatchObject({ expiresAt: null, updatesActive: false });
    expect(perpetual.renewalOptions.map((o) => o.tag)).toEqual(["MAINTENANCE", "ADD-ON"]);
    const expired = (await detail(L.expired.id)).body as unknown as Detail;
    expect(expired.license).toMatchObject({ status: "expired", canReveal: true, canManageDevices: false });
  });

  it("answers 404 for other accounts' licenses, guest licenses, unknown and malformed ids", async () => {
    const guest = await makeLicense(catalog, { accountId: null });
    for (const id of [foreignLicense.id, guest.license.id, "LIC-T00000000", "lic-1"]) {
      const { res, body } = await detail(id);
      expect(res.status, id).toBe(404);
      expect(errorOf(body)).toMatchObject({ code: "not_found", message: "License not found." });
    }
  });
});

describe("GET /api/account/devices", () => {
  const fleet = async (query = "") => {
    const res = await call(jar, devicesGET, `/api/account/devices${query}`);
    return { res, body: await bodyOf(res) };
  };
  const names = (body: Record<string, unknown>) => (body.devices as Array<{ name: string }>).map((d) => d.name);

  it("lists the account's devices with status, location and search filters and the stat tiles", async () => {
    const shop = await makeLocation(owner.accountId, "FC Road (main store)");
    await makeDevice(L.active.id, { name: "Billing counter PC", locationId: shop.id, lastSeenAt: at(-0.1) });
    await makeDevice(L.active.id, { name: "Back office laptop", os: "Windows 10 Home", lastSeenAt: at(-45) });
    await makeDevice(L.active.id, { name: "Old counter PC", deactivatedAt: at(-60), lastSeenAt: at(-61) });
    await makeDevice(L.expiring.id, { name: "Accounts PC", lastSeenAt: at(-1) });
    await makeDevice(L.expired.id, { name: "Expired PC", lastSeenAt: at(-2) });

    const { res, body } = await fleet();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(names(body)).toEqual(["Billing counter PC", "Accounts PC", "Expired PC", "Back office laptop"]);
    expect(JSON.stringify(body)).not.toContain("Stranger PC");
    expect(body.stats).toEqual({ activeDevices: 4, freeSlots: 5, staleDevices: 1, locations: 1 });
    expect(body.locations).toEqual([{ id: shop.id, name: "FC Road (main store)" }]);
    const byName = new Map((body.devices as Array<{ name: string; canDeactivate: boolean }>).map((d) => [d.name, d]));
    expect(byName.get("Accounts PC")?.canDeactivate).toBe(true);
    expect(byName.get("Expired PC")?.canDeactivate).toBe(false);

    expect(names((await fleet("?status=stale")).body)).toEqual(["Back office laptop"]);
    expect(names((await fleet("?status=inactive")).body)).toEqual(["Old counter PC"]);
    expect(names((await fleet("?status=all")).body)).toHaveLength(5);
    expect(names((await fleet(`?location=${shop.id}`)).body)).toEqual(["Billing counter PC"]);
    expect(names((await fleet("?location=none&status=all")).body)).not.toContain("Billing counter PC");
    expect(names((await fleet("?q=LAPTOP")).body)).toEqual(["Back office laptop"]);
    expect(names((await fleet("?q=windows%2010")).body)).toEqual(["Back office laptop"]);
    expect(names((await fleet(`?q=${L.expiring.id.toLowerCase()}`)).body)).toEqual(["Accounts PC"]);
    expect(names((await fleet(`?q=${foreignLicense.id}&status=all`)).body)).toEqual([]);
  });

  it("is readable by Viewers (without deactivate rights) and validates its parameters", async () => {
    await makeDevice(L.active.id, { name: "Counter" });
    await signIn(jar, await makeMember({ accountId: owner.accountId, role: "VIEWER" }));
    const { res, body } = await fleet();
    expect(res.status).toBe(200);
    expect(body.devices).toEqual([expect.objectContaining({ name: "Counter", canDeactivate: false })]);
    expect((await fleet("?status=deactivated")).res.status).toBe(422);
    expect((await fleet("?location=a%20b")).res.status).toBe(422);
    jar.clear();
    expect((await fleet()).res.status).toBe(401);
  });
});
