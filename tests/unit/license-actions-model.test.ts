import { describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { LicenseStatus, PlanType, PublishStatus } from "@/generated/prisma/enums";
import { DAY_MS } from "@/lib/dates";
import {
  derivedStatusWhere,
  deviceStatusWhere,
  isStaleDevice,
  licenseEventLabel,
  renewalOptionsFor,
  sortLicenseRows,
  type AccountLicenseRow,
  type RenewalLicense,
  type RenewalPlan,
} from "@/lib/licensing/account";
import { resetLimitError, secondsUntilNextIstYear } from "@/lib/licensing/devices";
import { DERIVED_LICENSE_STATUSES, deriveLicenseStatus } from "@/lib/licensing/status";

const NOW = new Date("2026-10-07T06:30:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

// ---------- A tiny evaluator for the where-clauses these helpers build ----------
type Cmp = { gt?: Date; gte?: Date; lt?: Date; lte?: Date; in?: unknown[]; not?: unknown };
function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null;
  if (cond instanceof Date || typeof cond !== "object") return value === cond || (value instanceof Date && cond instanceof Date && value.getTime() === cond.getTime());
  const c = cond as Cmp;
  if (c.in && !c.in.includes(value)) return false;
  if ("not" in c && c.not === null && value === null) return false;
  if (c.gt || c.gte || c.lt || c.lte) {
    if (!(value instanceof Date)) return false;
    const t = value.getTime();
    if (c.gt && !(t > c.gt.getTime())) return false;
    if (c.gte && !(t >= c.gte.getTime())) return false;
    if (c.lt && !(t < c.lt.getTime())) return false;
    if (c.lte && !(t <= c.lte.getTime())) return false;
  }
  return true;
}
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    if (k === "AND") return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
    return matchField(row[k], cond);
  });
}

describe("derivedStatusWhere", () => {
  it("selects exactly the licenses deriveLicenseStatus puts in each status", () => {
    const ends = [null, days(-400), days(-1), days(0), days(0.5), days(30), days(59.9), days(60), days(60.1), days(400)];
    for (const status of Object.values(LicenseStatus)) {
      for (const expiresAt of ends) {
        const license = { status, expiresAt };
        const derived = deriveLicenseStatus(license, NOW);
        for (const filter of DERIVED_LICENSE_STATUSES) {
          const where = derivedStatusWhere(filter, NOW) as Record<string, unknown>;
          expect(matches(license, where), `${status} ${expiresAt?.toISOString()} as ${filter}`).toBe(derived === filter);
        }
        expect(matches(license, derivedStatusWhere("all", NOW) as Record<string, unknown>)).toBe(true);
      }
    }
  });
});

describe("device status filter", () => {
  it("agrees with isStaleDevice and the active flag", () => {
    const seen = [days(-400), days(-31), days(-30.01), days(-30), days(-29), NOW];
    for (const lastSeenAt of seen) {
      for (const deactivatedAt of [null, days(-2)]) {
        const device = { lastSeenAt, deactivatedAt };
        const where = (s: Parameters<typeof deviceStatusWhere>[0]) => deviceStatusWhere(s, NOW) as Record<string, unknown>;
        expect(matches(device, where("stale"))).toBe(isStaleDevice(device, NOW));
        expect(matches(device, where("active"))).toBe(deactivatedAt === null);
        expect(matches(device, where("inactive"))).toBe(deactivatedAt !== null);
        expect(matches(device, where("all"))).toBe(true);
      }
    }
  });

  it("calls a device stale after 30 days without a check-in", () => {
    expect(isStaleDevice({ deactivatedAt: null, lastSeenAt: days(-30.01) }, NOW)).toBe(true);
    expect(isStaleDevice({ deactivatedAt: null, lastSeenAt: days(-29) }, NOW)).toBe(false);
    expect(isStaleDevice({ deactivatedAt: days(-1), lastSeenAt: days(-90) }, NOW)).toBe(false);
  });
});

// Keeps the where-clause types honest (compile-time only).
const _typed: Prisma.LicenseWhereInput = derivedStatusWhere("active", NOW);
void _typed;

// ---------- Renewal options ----------
const plan = (p: Partial<RenewalPlan> & Pick<RenewalPlan, "id" | "type">): RenewalPlan => ({
  name: p.id,
  interval: null,
  pricePaise: 100_000,
  perUnit: null,
  maxQty: null,
  multiDevice: false,
  archived: false,
  sortOrder: 0,
  ...p,
});
const annual = plan({ id: "med-annual", type: PlanType.ANNUAL, interval: "YEAR", pricePaise: 600_000 });
const oneTime = plan({ id: "med-onetime", type: PlanType.ONE_TIME, pricePaise: 1_500_000 });
const oneTimeMulti = plan({ id: "med-onetime-multi", type: PlanType.ONE_TIME, pricePaise: 3_000_000, multiDevice: true, sortOrder: -1 });
const amc = plan({ id: "med-amc", type: PlanType.MAINTENANCE, interval: "YEAR", pricePaise: 300_000 });
const addon = plan({ id: "med-device", type: PlanType.DEVICE_ADDON, pricePaise: 150_000 });
const trialPlan = plan({ id: "med-trial", type: PlanType.TRIAL, pricePaise: 0 });
const perUnit = plan({ id: "med-sub", type: PlanType.SUBSCRIPTION, interval: "MONTH", pricePaise: 50_000, perUnit: "terminal", maxQty: 5 });
const ALL = [annual, oneTime, oneTimeMulti, amc, addon, trialPlan, perUnit];

const lic = (l: Partial<RenewalLicense> = {}): RenewalLicense => ({
  status: LicenseStatus.ACTIVE,
  expiresAt: days(45),
  updatesUntil: days(45),
  deviceLimit: 3,
  plan: annual,
  productStatus: PublishStatus.PUBLISHED,
  ...l,
});
const tags = (opts: ReturnType<typeof renewalOptionsFor>) => opts.map((o) => `${o.tag}:${o.planId}:${o.available ? "on" : "off"}`);

describe("renewalOptionsFor", () => {
  it("annual license: renew the same plan from its end date, add computers, switch to single-device one-time", () => {
    const options = renewalOptionsFor(lic(), ALL, NOW);
    expect(tags(options)).toEqual(["RENEWAL:med-annual:on", "ADD-ON:med-device:on", "UPGRADE:med-onetime:on"]);
    expect(options[0]).toMatchObject({ kind: "RENEWAL", qty: 1, pricePaise: 600_000, from: days(45).toISOString() });
    expect(options[1]).toMatchObject({ kind: "ADDON", unitPricePaise: 150_000 });
    expect(options[2]).toMatchObject({ kind: "UPGRADE", planType: PlanType.ONE_TIME });
  });

  it("expired annual license renews from now and cannot add computers", () => {
    const options = renewalOptionsFor(lic({ expiresAt: days(-10), updatesUntil: days(-10) }), ALL, NOW);
    expect(tags(options)).toEqual(["RENEWAL:med-annual:on", "ADD-ON:med-device:off", "UPGRADE:med-onetime:on"]);
    expect(options[0]?.from).toBe(NOW.toISOString());
  });

  it("perpetual license renews updates through maintenance from max(now, updatesUntil)", () => {
    const options = renewalOptionsFor(lic({ expiresAt: null, updatesUntil: days(-100), plan: oneTime }), ALL, NOW);
    expect(tags(options)).toEqual(["MAINTENANCE:med-amc:on", "ADD-ON:med-device:on"]);
    expect(options[0]).toMatchObject({ kind: "RENEWAL", qty: 1, from: NOW.toISOString() });
    const later = renewalOptionsFor(lic({ expiresAt: null, updatesUntil: days(100), plan: oneTime }), ALL, NOW);
    expect(later[0]?.from).toBe(days(100).toISOString());
  });

  it("trial converts to the cheapest paid plan only", () => {
    const options = renewalOptionsFor(lic({ status: LicenseStatus.TRIAL, plan: trialPlan, deviceLimit: 1 }), ALL, NOW);
    expect(tags(options)).toEqual(["BUY:med-sub:on"]);
    expect(options[0]?.kind).toBe("UPGRADE");
  });

  it("per-unit renewals carry the device count (capped by maxQty)", () => {
    const options = renewalOptionsFor(lic({ plan: perUnit, deviceLimit: 4 }), ALL, NOW);
    expect(options[0]).toMatchObject({ tag: "RENEWAL", qty: 4, pricePaise: 200_000 });
    expect(renewalOptionsFor(lic({ plan: perUnit, deviceLimit: 9 }), ALL, NOW)[0]?.qty).toBe(5);
  });

  it("archived plans still renew, but are never offered as add-ons, maintenance or upgrades", () => {
    const archivedAnnual = { ...annual, archived: true };
    const archived = [archivedAnnual, { ...addon, archived: true }, { ...oneTime, archived: true }, { ...amc, archived: true }];
    expect(tags(renewalOptionsFor(lic({ plan: archivedAnnual }), archived, NOW))).toEqual(["RENEWAL:med-annual:on"]);
    expect(renewalOptionsFor(lic({ expiresAt: null, plan: oneTime }), archived, NOW)).toEqual([]);
  });

  it("offers nothing for revoked licenses or draft products; suspended licenses renew but cannot add computers", () => {
    expect(renewalOptionsFor(lic({ status: LicenseStatus.REVOKED }), ALL, NOW)).toEqual([]);
    expect(renewalOptionsFor(lic({ productStatus: PublishStatus.DRAFT }), ALL, NOW)).toEqual([]);
    expect(tags(renewalOptionsFor(lic({ status: LicenseStatus.SUSPENDED }), ALL, NOW))).toEqual([
      "RENEWAL:med-annual:on",
      "ADD-ON:med-device:off",
    ]);
  });
});

// ---------- Sorting and labels ----------
const row = (id: string, r: Partial<AccountLicenseRow>): AccountLicenseRow => ({
  id,
  productId: "p",
  productName: "Product",
  productShortName: "P",
  productIcon: "receipt_long",
  productTone: "sage",
  planId: "plan",
  planName: "Annual",
  planType: PlanType.ANNUAL,
  keyMasked: "MED-masked",
  keyLast4: "K8NM",
  status: "active",
  issuedAt: NOW.toISOString(),
  expiresAt: days(100).toISOString(),
  updatesUntil: days(100).toISOString(),
  deviceLimit: 3,
  devicesUsed: 1,
  orderId: null,
  ...r,
});

describe("sortLicenseRows", () => {
  const rows = [
    row("LIC-3", { productName: "Cheque Printing", expiresAt: null, devicesUsed: 1, deviceLimit: 1, status: "active", updatesUntil: days(10).toISOString() }),
    row("LIC-1", { productName: "Medical Store Billing", expiresAt: days(40).toISOString(), devicesUsed: 2, deviceLimit: 3, status: "expiring" }),
    row("LIC-2", { productName: "General Store GST", expiresAt: days(-5).toISOString(), devicesUsed: 0, deviceLimit: 1, status: "expired" }),
    row("LIC-4", { productName: "general store gst", expiresAt: days(40).toISOString(), devicesUsed: 0, deviceLimit: 2, status: "revoked" }),
  ];
  const ids = (sorted: AccountLicenseRow[]) => sorted.map((r) => r.id);

  it("sorts by end date with perpetual licenses last, ties by id", () => {
    expect(ids(sortLicenseRows(rows, { key: "expiry", dir: 1 }))).toEqual(["LIC-2", "LIC-1", "LIC-4", "LIC-3"]);
    expect(ids(sortLicenseRows(rows, { key: "expiry", dir: -1 }))).toEqual(["LIC-3", "LIC-1", "LIC-4", "LIC-2"]);
  });

  it("sorts by product (case-insensitive), status, device usage and updates", () => {
    expect(ids(sortLicenseRows(rows, { key: "product", dir: 1 }))).toEqual(["LIC-3", "LIC-2", "LIC-4", "LIC-1"]);
    expect(ids(sortLicenseRows(rows, { key: "status", dir: 1 }))).toEqual(["LIC-3", "LIC-2", "LIC-1", "LIC-4"]);
    expect(ids(sortLicenseRows(rows, { key: "devices", dir: -1 }))).toEqual(["LIC-3", "LIC-1", "LIC-2", "LIC-4"]);
    expect(ids(sortLicenseRows(rows, { key: "updates", dir: 1 }))[0]).toBe("LIC-3");
  });

  it("does not mutate its input", () => {
    const before = ids(rows);
    sortLicenseRows(rows, { key: "product", dir: -1 });
    expect(ids(rows)).toEqual(before);
  });
});

describe("history labels", () => {
  it("labels known LicenseEvent types and falls back for new ones", () => {
    expect(licenseEventLabel("issued")).toBe("License issued");
    expect(licenseEventLabel("key_revealed")).toBe("Key revealed");
    expect(licenseEventLabel("devices_reset")).toBe("Devices reset");
    expect(licenseEventLabel("updates_ended")).toBe("Updates period ended");
    expect(licenseEventLabel("seat_moved")).toBe("Seat moved");
    expect(licenseEventLabel("constructor")).toBe("Constructor");
  });
});

describe("reset limit", () => {
  it("answers 429 reset_limit with the portal copy and Retry-After until 1 January IST", () => {
    const err = resetLimitError(3, NOW);
    expect(err.status).toBe(429);
    expect(err.code).toBe("reset_limit");
    expect(err.message).toBe("You\u2019ve used all 3 self-service deactivations this year. Contact support to reset devices.");
    expect(err.details).toMatchObject({ selfServiceResetsLeft: 0, selfServiceResetsPerYear: 3 });
    // 2027-01-01 00:00 IST = 2026-12-31 18:30 UTC.
    const expected = (Date.parse("2026-12-31T18:30:00.000Z") - NOW.getTime()) / 1000;
    expect(err.headers?.["Retry-After"]).toBe(String(expected));
  });

  it("counts down to the IST new year, not the UTC one", () => {
    expect(secondsUntilNextIstYear(new Date("2026-12-31T18:29:00.000Z"))).toBe(60);
    // 00:01 IST on 1 January is already the new year: a full year to wait.
    expect(secondsUntilNextIstYear(new Date("2026-12-31T18:31:00.000Z"))).toBeGreaterThan(364 * 86_400);
  });
});
