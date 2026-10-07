import { describe, expect, it } from "vitest";
import type { LicenseStatus, ReleaseStatus } from "@/generated/prisma/enums";
import { addDays, fromIstParts } from "@/lib/dates";
import {
  type EntitlementLicense,
  ENTITLEMENT_MESSAGES,
  checkDownloadEntitlement,
  compareVersions,
  latestEligibleRelease,
  pickEntitlingLicense,
} from "@/lib/licensing/entitlement";

const now = fromIstParts({ year: 2026, month: 10, day: 6, hour: 12 });
const ago = (n: number) => addDays(now, -n);
const ahead = (n: number) => addDays(now, n);

type Lic = EntitlementLicense & { id: string };
const lic = (id: string, status: LicenseStatus, expiresAt: Date | null, updatesUntil: Date): Lic => ({
  id,
  status,
  expiresAt,
  updatesUntil,
});
const rel = (version: string, releasedAt: Date | null, status: ReleaseStatus = "PUBLISHED") => ({ version, status, releasedAt });

// Mirrors the prototype's sample data.
const medAnnual = lic("LIC-24017", "ACTIVE", ahead(41), ahead(41));
const chqOneTime = lic("LIC-23961", "ACTIVE", null, ago(200));
const gstRevoked = lic("LIC-24188", "REVOKED", ahead(345), ahead(345));
const gstTrialEnded = lic("LIC-24112", "TRIAL", ago(25), ago(25));
const suspended = lic("LIC-1", "SUSPENDED", ahead(100), ahead(100));
const trial = lic("LIC-2", "TRIAL", ahead(10), ahead(10));

const v421 = rel("4.2.1", ago(21));
const v410 = rel("4.1.0", ago(300));

describe("checkDownloadEntitlement", () => {
  it("allows active and trial licenses for a published release within the updates window", () => {
    expect(checkDownloadEntitlement(medAnnual, v421, now)).toEqual({ ok: true });
    expect(checkDownloadEntitlement(trial, rel("1.0.0", ago(1)), now)).toEqual({ ok: true });
  });

  it("one-time license: newer release is updates_ended, an older eligible release is allowed", () => {
    expect(checkDownloadEntitlement(chqOneTime, v421, now)).toEqual({ ok: false, reason: "updates_ended" });
    expect(checkDownloadEntitlement(chqOneTime, v410, now)).toEqual({ ok: true });
    expect(checkDownloadEntitlement(chqOneTime, rel("3.9.0", ago(200)), now)).toEqual({ ok: true });
  });

  it.each([
    ["revoked", gstRevoked, "revoked"],
    ["suspended", suspended, "suspended"],
    ["expired trial", gstTrialEnded, "expired"],
    ["expired annual", lic("x", "ACTIVE", ago(1), ago(1)), "expired"],
    ["expiring exactly now", lic("x", "ACTIVE", now, ahead(5)), "expired"],
  ] as const)("denies a %s license", (_label, license, reason) => {
    expect(checkDownloadEntitlement(license, v410, now)).toEqual({ ok: false, reason });
  });

  it.each([
    ["draft", rel("5.0.0", ago(1), "DRAFT")],
    ["withdrawn", rel("4.2.0", ago(30), "WITHDRAWN")],
    ["published without a date", rel("5.0.0", null)],
    ["scheduled in the future", rel("5.0.0", ahead(2))],
  ] as const)("denies a %s release as not_released", (_label, release) => {
    expect(checkDownloadEntitlement(medAnnual, release, now)).toEqual({ ok: false, reason: "not_released" });
  });

  it("license problems take precedence over release problems", () => {
    expect(checkDownloadEntitlement(gstRevoked, rel("5.0.0", null, "DRAFT"), now)).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("releasedAt <= updatesUntil boundary", () => {
  it("allows a release published at the exact updatesUntil instant", () => {
    const edge = ago(10);
    const license = lic("x", "ACTIVE", null, edge);
    expect(checkDownloadEntitlement(license, rel("2.0.0", edge), now)).toEqual({ ok: true });
    expect(checkDownloadEntitlement(license, rel("2.0.1", new Date(edge.getTime() + 1)), now)).toEqual({
      ok: false,
      reason: "updates_ended",
    });
  });
});

describe("pickEntitlingLicense", () => {
  it("prefers the entitled license with the latest updatesUntil", () => {
    const longer = lic("LIC-9", "ACTIVE", ahead(300), ahead(300));
    expect(pickEntitlingLicense([medAnnual, gstRevoked, longer, trial], v421, now)).toEqual({ ok: true, license: longer });
  });

  it("breaks ties on updatesUntil in favour of the longer-running license", () => {
    const perpetual = lic("LIC-P", "ACTIVE", null, ahead(41));
    expect(pickEntitlingLicense([medAnnual, perpetual], v421, now)).toEqual({ ok: true, license: perpetual });
  });

  it("returns the most actionable failure when nothing entitles", () => {
    expect(pickEntitlingLicense([gstRevoked, chqOneTime], v421, now)).toEqual({ ok: false, reason: "updates_ended", license: chqOneTime });
    expect(pickEntitlingLicense([suspended, gstTrialEnded], v421, now)).toEqual({ ok: false, reason: "expired", license: gstTrialEnded });
    expect(pickEntitlingLicense([gstRevoked, suspended], v421, now)).toEqual({ ok: false, reason: "suspended", license: suspended });
    expect(pickEntitlingLicense([gstRevoked], v421, now)).toEqual({ ok: false, reason: "revoked", license: gstRevoked });
  });

  it("reports no_license and not_released", () => {
    expect(pickEntitlingLicense([], v421, now)).toEqual({ ok: false, reason: "no_license", license: null });
    expect(pickEntitlingLicense([medAnnual], rel("9.0.0", null, "DRAFT"), now)).toEqual({
      ok: false,
      reason: "not_released",
      license: null,
    });
  });
});

describe("latestEligibleRelease", () => {
  const releases = [
    rel("3.0.0", ago(700)),
    v410,
    rel("4.3.0", ago(2), "DRAFT"),
    v421,
    rel("4.2.0", ago(60), "WITHDRAWN"),
    rel("5.0.0", ahead(3)),
  ];

  it("returns the newest published release the license covers", () => {
    expect(latestEligibleRelease(releases, medAnnual, now)?.version).toBe("4.2.1");
    expect(latestEligibleRelease(releases, chqOneTime, now)?.version).toBe("4.1.0");
    expect(latestEligibleRelease(releases, trial, now)?.version).toBe("4.2.1");
  });

  it("returns null when the license is not entitled or nothing qualifies", () => {
    expect(latestEligibleRelease(releases, gstRevoked, now)).toBeNull();
    expect(latestEligibleRelease(releases, gstTrialEnded, now)).toBeNull();
    expect(latestEligibleRelease(releases, suspended, now)).toBeNull();
    expect(latestEligibleRelease(releases, lic("x", "ACTIVE", null, ago(800)), now)).toBeNull();
    expect(latestEligibleRelease([], medAnnual, now)).toBeNull();
  });

  it("breaks same-day ties by version", () => {
    const day = ago(5);
    const same = [rel("4.9.0", day), rel("4.10.0", day), rel("4.2.0", day)];
    expect(latestEligibleRelease(same, medAnnual, now)?.version).toBe("4.10.0");
  });

  it("picks the highest version, not the latest release date (a 4.1.5 hotfix after 4.2.0)", () => {
    const hotfix = [rel("4.2.0", ago(30)), rel("4.1.5", ago(5)), rel("4.1.0", ago(90))];
    expect(latestEligibleRelease(hotfix, medAnnual, now)?.version).toBe("4.2.0");
    // A final release outranks its own pre-releases even when they came later; build metadata is ignored.
    const pre = [rel("4.3.0-beta.2", ago(2)), rel("4.3.0", ago(4)), rel("4.3.0-rc.1", ago(1))];
    expect(latestEligibleRelease(pre, medAnnual, now)?.version).toBe("4.3.0");
    // Coverage still decides first: updates that ended before 4.2.0 get the newest covered release.
    const ended = lic("x", "ACTIVE", null, ago(20));
    expect(latestEligibleRelease([...hotfix, rel("4.3.0", ago(10))], ended, now)?.version).toBe("4.2.0");
  });
});

describe("compareVersions", () => {
  it.each([
    ["4.10.0", "4.9.2", 1],
    ["4.2.1", "4.2.1", 0],
    ["4.2", "4.2.0", 0],
    ["3.9.9", "4.0.0", -1],
    ["10.0.0", "9.99.99", 1],
    // Semver precedence: a pre-release ranks below its release, build metadata is ignored.
    ["4.3.0", "4.3.0-beta.2", 1],
    ["4.3.0-beta.2", "4.3.0", -1],
    ["4.3.0+20261007", "4.3.0", 0],
    ["4.3.0-beta.2+build.5", "4.3.0-beta.2", 0],
    ["4.3.0-beta.10", "4.3.0-beta.2", 1],
    ["4.3.0-rc.1", "4.3.0-beta.11", 1],
    ["4.3.0-alpha", "4.3.0-alpha.1", -1],
    ["4.3.0-1", "4.3.0-alpha", -1],
    ["4.3.0-beta.2", "4.2.9", 1],
    // The 4-part versions apps may send, and leading zeros.
    ["4.2.1.1830", "4.2.1", 1],
    ["4.2.1.0", "4.2.1", 0],
    ["4.02.1", "4.2.1", 0],
    ["4.2.1.12345678901234567890", "4.2.1.12345678901234567889", 1],
  ] as const)("%s vs %s", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
    expect(compareVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
  });
});

describe("ENTITLEMENT_MESSAGES", () => {
  it("has plain-language copy for every reason, with curly apostrophes", () => {
    for (const reason of ["revoked", "suspended", "expired", "updates_ended", "not_released", "no_license"] as const) {
      expect(ENTITLEMENT_MESSAGES[reason].length).toBeGreaterThan(10);
      expect(ENTITLEMENT_MESSAGES[reason]).not.toContain("'");
    }
    expect(ENTITLEMENT_MESSAGES.updates_ended).toContain("needs renewal");
    expect(ENTITLEMENT_MESSAGES.expired).toContain("Downloads need an active license");
  });
});
