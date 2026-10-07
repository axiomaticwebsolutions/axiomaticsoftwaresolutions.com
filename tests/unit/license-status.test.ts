import { describe, expect, it } from "vitest";
import type { LicenseStatus } from "@/generated/prisma/enums";
import { DAY_MS, addDays, fromIstParts } from "@/lib/dates";
import { TONE_NAMES } from "@/lib/design/tokens";
import {
  DERIVED_LICENSE_STATUSES,
  EXPIRING_DAYS,
  LICENSE_STATUS_META,
  consumeSelfServiceReset,
  deriveLicenseStatus,
  isExpired,
  isUsableLicense,
  selfServiceLimitMessage,
  selfServiceResetsLeft,
  updatesActive,
} from "@/lib/licensing/status";

const now = fromIstParts({ year: 2026, month: 10, day: 6, hour: 12 });
const lic = (status: LicenseStatus, expiresAt: Date | null) => ({ status, expiresAt });

describe("deriveLicenseStatus", () => {
  it.each([
    ["REVOKED beats an expired date", lic("REVOKED", addDays(now, -10)), "revoked"],
    ["REVOKED with a future date", lic("REVOKED", addDays(now, 300)), "revoked"],
    ["SUSPENDED beats an expired date", lic("SUSPENDED", addDays(now, -10)), "suspended"],
    ["SUSPENDED perpetual", lic("SUSPENDED", null), "suspended"],
    ["expired active", lic("ACTIVE", addDays(now, -1)), "expired"],
    ["expired trial is expired, not trial", lic("TRIAL", addDays(now, -25)), "expired"],
    ["running trial, even within 60 days", lic("TRIAL", addDays(now, 5)), "trial"],
    ["active ending in 41 days", lic("ACTIVE", addDays(now, 41)), "expiring"],
    ["active ending in 59.9 days", lic("ACTIVE", new Date(now.getTime() + EXPIRING_DAYS * DAY_MS - 1)), "expiring"],
    ["active ending in exactly 60 days", lic("ACTIVE", addDays(now, EXPIRING_DAYS)), "active"],
    ["active ending in 300 days", lic("ACTIVE", addDays(now, 300)), "active"],
    ["perpetual one-time", lic("ACTIVE", null), "active"],
  ] as const)("%s", (_label, license, expected) => {
    expect(deriveLicenseStatus(license, now)).toBe(expected);
  });

  it("treats the expiry instant itself as expired", () => {
    expect(deriveLicenseStatus(lic("ACTIVE", now), now)).toBe("expired");
    expect(deriveLicenseStatus(lic("ACTIVE", new Date(now.getTime() + 1)), now)).toBe("expiring");
    expect(isExpired({ expiresAt: now }, now)).toBe(true);
    expect(isExpired({ expiresAt: null }, now)).toBe(false);
  });
});

describe("LICENSE_STATUS_META", () => {
  it("has an entry for every derived status with a known tone and an icon", () => {
    expect(Object.keys(LICENSE_STATUS_META).sort()).toEqual([...DERIVED_LICENSE_STATUSES].sort());
    for (const meta of Object.values(LICENSE_STATUS_META)) {
      expect(TONE_NAMES).toContain(meta.tone);
      expect(meta.icon).toMatch(/^[a-z_]+$/);
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });

  it("matches the portal and admin prototypes", () => {
    expect(LICENSE_STATUS_META.active).toMatchObject({ label: "Active", tone: "sage", icon: "verified" });
    expect(LICENSE_STATUS_META.expiring).toMatchObject({ label: "Expiring soon", adminLabel: "Expiring", tone: "peach", icon: "event_upcoming" });
    expect(LICENSE_STATUS_META.expired).toMatchObject({ label: "Expired", tone: "peach", icon: "event_busy" });
    expect(LICENSE_STATUS_META.trial).toMatchObject({ label: "Trial", tone: "blue", icon: "timer" });
    expect(LICENSE_STATUS_META.suspended).toMatchObject({ label: "Suspended", tone: "pink", icon: "pause_circle" });
    expect(LICENSE_STATUS_META.revoked).toMatchObject({ label: "Revoked", tone: "pink", icon: "block" });
  });

  it("counts active, expiring and trial as usable", () => {
    const usable = DERIVED_LICENSE_STATUSES.filter((s) => LICENSE_STATUS_META[s].usable);
    expect([...usable].sort()).toEqual(["active", "expiring", "trial"]);
    expect(isUsableLicense(lic("TRIAL", addDays(now, 3)), now)).toBe(true);
    expect(isUsableLicense(lic("ACTIVE", addDays(now, -3)), now)).toBe(false);
  });
});

describe("updatesActive", () => {
  it("is true strictly before updatesUntil", () => {
    expect(updatesActive({ updatesUntil: addDays(now, 1) }, now)).toBe(true);
    expect(updatesActive({ updatesUntil: now }, now)).toBe(false);
    expect(updatesActive({ updatesUntil: addDays(now, -200) }, now)).toBe(false);
  });
});

describe("self-service device deactivations", () => {
  const jan1 = fromIstParts({ year: 2027, month: 1, day: 1, hour: 0, minute: 0 });

  it("counts down from 3 within the same IST calendar year", () => {
    expect(selfServiceResetsLeft({ selfServiceResets: 0, resetsYear: 2026 }, now)).toBe(3);
    expect(selfServiceResetsLeft({ selfServiceResets: 1, resetsYear: 2026 }, now)).toBe(2);
    expect(selfServiceResetsLeft({ selfServiceResets: 3, resetsYear: 2026 }, now)).toBe(0);
    expect(selfServiceResetsLeft({ selfServiceResets: 7, resetsYear: 2026 }, now)).toBe(0);
    expect(selfServiceResetsLeft({ selfServiceResets: 1, resetsYear: 2026 }, now, 5)).toBe(4);
  });

  it("resets when the IST calendar year changes", () => {
    const used = { selfServiceResets: 3, resetsYear: 2026 };
    expect(selfServiceResetsLeft(used, jan1)).toBe(3);
    // 31 Dec 2026 23:59 IST is still 2026; 18:30 UTC on 31 Dec is already 2027 in India.
    expect(selfServiceResetsLeft(used, new Date(jan1.getTime() - 60_000))).toBe(0);
    expect(selfServiceResetsLeft(used, new Date(Date.UTC(2026, 11, 31, 18, 30)))).toBe(3);
  });

  it("consumes one deactivation and rolls the counter into the current year", () => {
    expect(consumeSelfServiceReset({ selfServiceResets: 1, resetsYear: 2026 }, now)).toEqual({ selfServiceResets: 2, resetsYear: 2026 });
    expect(consumeSelfServiceReset({ selfServiceResets: 3, resetsYear: 2026 }, jan1)).toEqual({ selfServiceResets: 1, resetsYear: 2027 });
    expect(consumeSelfServiceReset({ selfServiceResets: 3, resetsYear: 2026 }, now)).toBeNull();
  });

  it("uses the portal copy for the limit message", () => {
    expect(selfServiceLimitMessage()).toBe(
      "You\u2019ve used all 3 self-service deactivations this year. Contact support to reset devices.",
    );
  });
});
