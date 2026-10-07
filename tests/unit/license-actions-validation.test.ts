import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEVICE_NAME_MAX,
  isLicenseIdShape,
  isRecordIdShape,
  LICENSE_ACTION_ERRORS,
  parseDeviceListQuery,
  parseLicenseListQuery,
  revealKeySchema,
  updateDeviceSchema,
} from "@/lib/validation/license-actions";

const params = (q: Record<string, string>) => new URLSearchParams(q);
const messages = (result: { success: boolean; error?: z.core.$ZodError }) => result.error?.issues.map((i) => i.message) ?? [];

describe("reveal body", () => {
  it("needs a non-empty password and rejects unknown keys", () => {
    expect(revealKeySchema.parse({ password: "Correct1horse" })).toEqual({ password: "Correct1horse" });
    expect(messages(revealKeySchema.safeParse({ password: "" }))).toEqual([LICENSE_ACTION_ERRORS.password]);
    expect(messages(revealKeySchema.safeParse({}))).toEqual([LICENSE_ACTION_ERRORS.password]);
    expect(revealKeySchema.safeParse({ password: "x".repeat(1025) }).success).toBe(false);
    expect(revealKeySchema.safeParse({ password: "Correct1horse", accountId: "acc_1" }).success).toBe(false);
  });

  it("keeps the password exactly as typed (no trimming)", () => {
    expect(revealKeySchema.parse({ password: "  spaced 1 " }).password).toBe("  spaced 1 ");
  });
});

describe("device update body", () => {
  it("trims and collapses the name and allows 1-80 characters", () => {
    expect(updateDeviceSchema.parse({ name: "  Billing \t counter   PC " })).toEqual({ name: "Billing counter PC" });
    expect(updateDeviceSchema.parse({ name: "x".repeat(DEVICE_NAME_MAX) }).name).toHaveLength(DEVICE_NAME_MAX);
    expect(messages(updateDeviceSchema.safeParse({ name: "x".repeat(DEVICE_NAME_MAX + 1) }))).toEqual([
      LICENSE_ACTION_ERRORS.deviceNameTooLong,
    ]);
    expect(messages(updateDeviceSchema.safeParse({ name: "   " }))).toEqual([LICENSE_ACTION_ERRORS.deviceName]);
  });

  it("rejects control characters in the name", () => {
    expect(messages(updateDeviceSchema.safeParse({ name: "PC" + String.fromCharCode(0) }))).toEqual([
      LICENSE_ACTION_ERRORS.deviceNameCharacters,
    ]);
    expect(updateDeviceSchema.safeParse({ name: "PC" + String.fromCharCode(0x2028) + "2" }).success).toBe(false);
  });

  it("accepts a location id or null and needs at least one change", () => {
    expect(updateDeviceSchema.parse({ locationId: "seed_loc_loc1" })).toEqual({ locationId: "seed_loc_loc1" });
    expect(updateDeviceSchema.parse({ locationId: null })).toEqual({ locationId: null });
    expect(messages(updateDeviceSchema.safeParse({ locationId: "../x" }))).toEqual([LICENSE_ACTION_ERRORS.location]);
    expect(messages(updateDeviceSchema.safeParse({}))).toEqual([LICENSE_ACTION_ERRORS.nothingToUpdate]);
    expect(updateDeviceSchema.safeParse({ name: "PC", licenseId: "LIC-1" }).success).toBe(false);
  });
});

describe("id shapes", () => {
  it("accepts license ids and record ids only", () => {
    expect(isLicenseIdShape("LIC-24017")).toBe(true);
    expect(isLicenseIdShape("LIC-T1A2B3C4")).toBe(true);
    expect(isLicenseIdShape("lic-24017")).toBe(false);
    expect(isLicenseIdShape("LIC-24017;")).toBe(false);
    expect(isRecordIdShape("seed_dev_d1")).toBe(true);
    expect(isRecordIdShape("cmg1abcdef0000xyz")).toBe(true);
    expect(isRecordIdShape("a/b")).toBe(false);
    expect(isRecordIdShape("x".repeat(65))).toBe(false);
  });
});

describe("license list query", () => {
  it("defaults to every license, expiry ascending", () => {
    expect(parseLicenseListQuery(params({}))).toEqual({ status: "all", product: "all", q: "", sort: { key: "expiry", dir: 1 } });
  });

  it("parses filters, search and descending sorts; ignores unknown and empty parameters", () => {
    expect(
      parseLicenseListQuery(params({ status: "expiring", product: "medical-billing", q: "  k8nm ", sort: "-devices", page: "2", x: "" })),
    ).toEqual({ status: "expiring", product: "medical-billing", q: "k8nm", sort: { key: "devices", dir: -1 } });
    expect(parseLicenseListQuery(params({ status: "", sort: "" })).status).toBe("all");
  });

  it("rejects unknown statuses, sorts and products with a ZodError (422)", () => {
    expect(() => parseLicenseListQuery(params({ status: "EXPIRED" }))).toThrow(z.ZodError);
    expect(() => parseLicenseListQuery(params({ sort: "price" }))).toThrow(z.ZodError);
    expect(() => parseLicenseListQuery(params({ sort: "--expiry" }))).toThrow(z.ZodError);
    expect(() => parseLicenseListQuery(params({ product: "Medical Billing" }))).toThrow(z.ZodError);
    expect(() => parseLicenseListQuery(params({ q: "x".repeat(101) }))).toThrow(z.ZodError);
  });
});

describe("device list query", () => {
  it("defaults to active devices in every location", () => {
    expect(parseDeviceListQuery(params({}))).toEqual({ status: "active", location: "all", q: "" });
  });

  it("parses status, location and search", () => {
    expect(parseDeviceListQuery(params({ status: "stale", location: "none", q: " laptop " }))).toEqual({
      status: "stale",
      location: "none",
      q: "laptop",
    });
    expect(parseDeviceListQuery(params({ status: "inactive", location: "seed_loc_loc2" })).location).toBe("seed_loc_loc2");
    expect(() => parseDeviceListQuery(params({ status: "deactivated" }))).toThrow(z.ZodError);
    expect(() => parseDeviceListQuery(params({ location: "a b" }))).toThrow(z.ZodError);
  });
});
