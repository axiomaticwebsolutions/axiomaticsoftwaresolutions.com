/**
 * Server loaders of the portal license and device views (components/account/licenses/data.ts and
 * components/account/devices/data.ts): account scoping, the renewal line "Renew selected" adds per license, the
 * detail's cart lines, add-on and trial plan choices, and the fleet's per-license self-service limits.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadDeviceFleet } from "@/components/account/devices/data";
import { loadLicenseDetail, loadLicenseList } from "@/components/account/licenses/data";
import { DAY, makeCatalog, makeDevice, makeLicense, makeMember, type Catalog } from "./license-actions-fixtures";

let catalog: Catalog;

beforeAll(async () => {
  catalog = await makeCatalog();
});

describe("loadLicenseList", () => {
  it("lists only the account's licenses with the renewal line of each one", async () => {
    const owner = await makeMember();
    const other = await makeMember();
    const annual = await makeLicense(catalog, { accountId: owner.accountId, expiresAt: new Date(Date.now() + 30 * DAY) });
    const oneTime = await makeLicense(catalog, { accountId: owner.accountId, plan: catalog.oneTime, expiresAt: null, deviceLimit: 1 });
    const trial = await makeLicense(catalog, { accountId: owner.accountId, plan: catalog.trial, status: "TRIAL", expiresAt: new Date(Date.now() - 2 * DAY) });
    const revoked = await makeLicense(catalog, { accountId: owner.accountId, status: "REVOKED" });
    const foreign = await makeLicense(catalog, { accountId: other.accountId });

    const data = await loadLicenseList({ accountId: owner.accountId, role: "OWNER" });
    const byId = new Map(data.rows.map((r) => [r.id, r]));
    expect(data.total).toBe(4);
    expect(byId.has(foreign.license.id)).toBe(false);
    expect(byId.get(annual.license.id)?.renewal).toEqual({
      planId: catalog.annual.id,
      qty: 1,
      maxQty: 1,
      kind: "RENEWAL",
      targetLicenseId: annual.license.id,
    });
    expect(byId.get(oneTime.license.id)?.renewal).toMatchObject({ planId: catalog.amc.id, kind: "RENEWAL", maxQty: 1 });
    // A trial converts through an UPGRADE to the cheapest paid plan.
    expect(byId.get(trial.license.id)?.renewal).toMatchObject({ planId: catalog.annual.id, kind: "UPGRADE" });
    expect(byId.get(trial.license.id)?.status).toBe("expired");
    expect(byId.get(revoked.license.id)?.renewal).toBeNull();
    expect(byId.get(annual.license.id)?.keyMasked).toMatch(/^[A-Z]{3}-••••-••••-••••-[A-Z0-9]{4}$/);
  });

  it("leaves renewal lines out for roles that cannot buy", async () => {
    const owner = await makeMember();
    await makeLicense(catalog, { accountId: owner.accountId });
    const data = await loadLicenseList({ accountId: owner.accountId, role: "TECHNICAL" });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.renewal).toBeNull();
  });
});

describe("loadLicenseDetail", () => {
  it("answers null for unknown licenses and licenses of another account", async () => {
    const owner = await makeMember();
    const other = await makeMember();
    const foreign = await makeLicense(catalog, { accountId: other.accountId });
    expect(await loadLicenseDetail(owner.accountId, "OWNER", foreign.license.id)).toBeNull();
    expect(await loadLicenseDetail(owner.accountId, "OWNER", "LIC-NOPE404")).toBeNull();
  });

  it("gives every option its cart line and describes the device add-on", async () => {
    const owner = await makeMember();
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const data = await loadLicenseDetail(owner.accountId, "OWNER", license.id);
    expect(data?.options.map((o) => [o.tag, o.line.kind, o.line.targetLicenseId])).toEqual([
      ["RENEWAL", "RENEWAL", license.id],
      ["ADD-ON", "ADDON", license.id],
      ["UPGRADE", "UPGRADE", license.id],
    ]);
    expect(data?.addon).toEqual({ planId: catalog.addon.id, unitPricePaise: 150_000, maxQty: 10, available: true });
    expect(data?.paidPlans).toEqual([]);
    expect(data?.detail.license.canReveal).toBe(true);
  });

  it("lists the paid plans a trial can convert to, as UPGRADE lines of the trial license", async () => {
    const owner = await makeMember();
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, plan: catalog.trial, status: "TRIAL", deviceLimit: 1 });
    const data = await loadLicenseDetail(owner.accountId, "BILLING", license.id);
    expect(data?.options.map((o) => o.tag)).toEqual(["BUY"]);
    expect(data?.paidPlans.map((p) => [p.planId, p.line.kind, p.line.targetLicenseId])).toEqual([
      [catalog.annual.id, "UPGRADE", license.id],
      [catalog.oneTime.id, "UPGRADE", license.id],
    ]);
    expect(data?.detail.license.canReveal).toBe(false);
  });
});

describe("loadDeviceFleet", () => {
  it("marks devices on unusable licenses and reports the deactivations left per license", async () => {
    const owner = await makeMember();
    const live = await makeLicense(catalog, { accountId: owner.accountId, selfServiceResets: 1 });
    const ended = await makeLicense(catalog, { accountId: owner.accountId, expiresAt: new Date(Date.now() - DAY) });
    const a = await makeDevice(live.license.id, { name: "Billing counter PC" });
    const b = await makeDevice(ended.license.id, { name: "Old till" });
    const other = await makeMember();
    const foreign = await makeLicense(catalog, { accountId: other.accountId });
    await makeDevice(foreign.license.id);

    const data = await loadDeviceFleet({ accountId: owner.accountId, role: "OWNER" });
    expect(data.rows.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(data.rows.find((d) => d.id === a.id)?.licenseUsable).toBe(true);
    expect(data.rows.find((d) => d.id === b.id)?.licenseUsable).toBe(false);
    expect(data.perYear).toBeGreaterThan(0);
    expect(data.resetsLeft[live.license.id]).toBe(data.perYear - 1);
    expect(data.resetsLeft[foreign.license.id]).toBeUndefined();
  });
});
