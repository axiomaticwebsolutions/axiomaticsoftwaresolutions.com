/** Pure helpers of the admin Customers, Licenses and Renewals modules. */
import { describe, expect, it } from "vitest";
import { emailBadge, locationLabel } from "@/lib/admin/customers/model";
import { mergeLicenseHistory } from "@/lib/admin/licenses/history";
import { csvDateIST, datedCsvName, filterSummary, likeContains, productFilterParam } from "@/lib/admin/licenses/list-state";
import { deviceUsage, extendAuditAction, extendedTerms, renewalValuePaise } from "@/lib/admin/licenses/model";
import { LICENSES_LIST } from "@/lib/admin/licenses/model";
import {
  inRenewalWindow,
  istDayKey,
  reminderTemplateFor,
  renewalDaysCell,
  renewalDaysLeft,
  renewalReminderDayPrefix,
  RENEWAL_COPY,
} from "@/lib/admin/renewals/model";
import { parseListState } from "@/lib/url-state";

const DAY = 86_400_000;
const NOW = new Date("2026-10-07T06:30:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe("extendedTerms", () => {
  it("moves dates on from the later of now and their value; perpetual licenses keep no end date", () => {
    expect(extendedTerms({ expiresAt: at(100), updatesUntil: at(100) }, 30, NOW)).toEqual({ expiresAt: at(130), updatesUntil: at(130) });
    expect(extendedTerms({ expiresAt: at(-20), updatesUntil: at(-20) }, 30, NOW)).toEqual({ expiresAt: at(30), updatesUntil: at(30) });
    expect(extendedTerms({ expiresAt: null, updatesUntil: at(5) }, 7, NOW)).toEqual({ expiresAt: null, updatesUntil: at(12) });
    expect(() => extendedTerms({ expiresAt: null, updatesUntil: NOW }, 0, NOW)).toThrow(RangeError);
    expect(extendAuditAction(30)).toBe("Extended license +30 days");
    expect(extendAuditAction(1)).toBe("Extended license +1 day");
  });
});

describe("deviceUsage and renewal value", () => {
  it("labels the bar and marks a full license", () => {
    expect(deviceUsage(1, 3)).toEqual({ label: "1 / 3", pct: 33, full: false });
    expect(deviceUsage(3, 3)).toEqual({ label: "3 / 3", pct: 100, full: true });
    expect(deviceUsage(0, 0)).toEqual({ label: "0 / 0", pct: 0, full: true });
  });
  it("multiplies per-terminal plans by the device limit", () => {
    expect(renewalValuePaise({ pricePaise: 69_900, perUnit: "terminal" }, 3)).toBe(209_700);
    expect(renewalValuePaise({ pricePaise: 499_900, perUnit: null }, 3)).toBe(499_900);
  });
});

describe("mergeLicenseHistory", () => {
  const label = (type: string) => ({ suspended: "Suspended", issued: "License issued", activated: "Activated" })[type] ?? type;
  it("keeps the audit row of a staff action and drops its paired event; newest first", () => {
    const history = mergeLicenseHistory(
      [
        { id: "e1", type: "issued", actor: "System", detail: "Order AX-1", createdAt: at(-30) },
        { id: "e2", type: "activated", actor: "Device", detail: "Front desk", createdAt: at(-29) },
        { id: "e3", type: "suspended", actor: "Sneha", detail: null, createdAt: at(-1) },
      ],
      [{ id: "a1", action: "Suspended license", actorName: "Sneha", reason: "Chargeback", detail: null, createdAt: new Date(at(-1).getTime() + 20) }],
      label,
      12,
    );
    expect(history.map((h) => [h.label, h.by])).toEqual([
      ["Suspended license", "Sneha \u00B7 Chargeback"],
      ["Activated", "Device \u00B7 Front desk"],
      ["License issued", "System \u00B7 Order AX-1"],
    ]);
  });
  it("keeps events without a matching audit row and honours the limit", () => {
    const history = mergeLicenseHistory(
      [{ id: "e1", type: "suspended", actor: "Old staff", detail: null, createdAt: at(-10) }],
      [{ id: "a1", action: "Suspended license", actorName: "Sneha", reason: "Fraud", detail: null, createdAt: at(-1) }],
      label,
      1,
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.label).toBe("Suspended license");
  });
});

describe("renewals", () => {
  it("computes DAYS like the prototype and colours the cell", () => {
    expect(renewalDaysLeft(at(10.2), NOW)).toBe(11);
    expect(renewalDaysLeft(at(-2.5), NOW)).toBe(-2);
    expect(renewalDaysCell(-12)).toEqual({ label: "-12 (lapsed)", tone: "danger" });
    expect(renewalDaysCell(30)).toEqual({ label: "30", tone: "warn" });
    expect(renewalDaysCell(31)).toEqual({ label: "31", tone: "default" });
  });
  it("picks the reminder template by the end date", () => {
    expect(reminderTemplateFor(at(20), NOW)).toBe("renewal_30");
    expect(reminderTemplateFor(at(7), NOW)).toBe("renewal_7");
    expect(reminderTemplateFor(at(-1), NOW)).toBe("license_expired");
    expect(reminderTemplateFor(NOW, NOW)).toBe("license_expired");
  });
  it("bounds the row set to 60 days ahead and 30 behind", () => {
    expect(inRenewalWindow(at(59), NOW)).toBe(true);
    expect(inRenewalWindow(at(61), NOW)).toBe(false);
    expect(inRenewalWindow(at(-29), NOW)).toBe(true);
    expect(inRenewalWindow(at(-31), NOW)).toBe(false);
    expect(inRenewalWindow(null, NOW)).toBe(false);
  });
  it("deduplicates per license, template and IST day", () => {
    expect(istDayKey(new Date("2026-10-07T18:29:00.000Z"))).toBe("2026-10-07");
    expect(istDayKey(new Date("2026-10-07T18:31:00.000Z"))).toBe("2026-10-08");
    expect(renewalReminderDayPrefix("LIC-1", "renewal_7", NOW)).toBe("renewal:LIC-1:renewal_7:2026-10-07:");
    expect(RENEWAL_COPY.queued({ queued: [{ id: "a", templateId: "renewal_30", recipients: 1 }], skipped: [{ id: "b", reason: "x" }] })).toBe("1 reminder queued \u00B7 1 skipped");
  });
});

describe("list helpers", () => {
  it("escapes LIKE wildcards, checks product slugs and formats CSV dates in IST", () => {
    expect(likeContains("50%_off!")).toBe("%50!%!_off!!%");
    expect(productFilterParam("medical-billing")).toBe("medical-billing");
    expect(productFilterParam("Robert'); DROP")).toBeUndefined();
    expect(csvDateIST("2026-10-07T20:00:00.000Z")).toBe("2026-10-08");
    expect(csvDateIST(null)).toBe("");
    expect(datedCsvName("licenses", NOW)).toBe("licenses-2026-10-07.csv");
    expect(filterSummary({ q: "abc", filters: { status: "expiring", product: undefined } })).toBe("status: expiring \u00B7 search");
    expect(filterSummary({ q: "", filters: {} })).toBeNull();
  });
  it("reads the licenses URL state with bracket filters", () => {
    const state = parseListState(new URLSearchParams("filter[status]=expiring&filter[devices]=full&sort=-expires&page=2"), LICENSES_LIST);
    expect(state).toMatchObject({ filters: { status: "expiring", devices: "full", product: "all" }, sort: { id: "expires", desc: true }, page: 2 });
    expect(parseListState(new URLSearchParams("filter[status]=bogus"), LICENSES_LIST).filters.status).toBe("all");
  });
  it("labels the customer email badge and location", () => {
    expect(emailBadge(true).label).toBe("Verified");
    expect(emailBadge(false).tone).toBe("peach");
    expect(emailBadge(null).label).toBe("No owner");
    expect(locationLabel("Jaipur", "Rajasthan")).toBe("Jaipur, Rajasthan");
    expect(locationLabel(null, "Kerala")).toBe("Kerala");
  });
});
