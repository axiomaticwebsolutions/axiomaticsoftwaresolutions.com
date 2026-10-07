import { describe, expect, it } from "vitest";
import { DAY_MS, addDays, fromIstParts, istParts } from "@/lib/dates";
import {
  type LicenseTerms,
  type TermPlan,
  LicenseTermsError,
  addonTerms,
  newLicenseTerms,
  renewalTerms,
  upgradeTerms,
} from "@/lib/licensing/terms";

const plan = (over: Partial<TermPlan> & Pick<TermPlan, "type">): TermPlan => ({
  interval: null,
  trialDays: null,
  deviceLimit: null,
  perUnit: null,
  updatesMonths: null,
  ...over,
});

const annual = plan({ type: "ANNUAL", interval: "YEAR", deviceLimit: 3 });
const oneTime = plan({ type: "ONE_TIME", deviceLimit: 1, updatesMonths: 12 });
const multi = plan({ type: "ONE_TIME", deviceLimit: 5, updatesMonths: 12 });
const monthly = plan({ type: "SUBSCRIPTION", interval: "MONTH", deviceLimit: 1, perUnit: "terminal" });
const yearly = plan({ type: "SUBSCRIPTION", interval: "YEAR", deviceLimit: 1, perUnit: "terminal" });
const trial = plan({ type: "TRIAL", trialDays: 7, deviceLimit: 1 });
const addon = plan({ type: "DEVICE_ADDON" });
const amc = plan({ type: "MAINTENANCE", interval: "YEAR" });

/** 14:30 IST on the given IST calendar date. */
const ist = (year: number, month: number, day: number, hour = 14, minute = 30) =>
  fromIstParts({ year, month, day, hour, minute });

const paidAt = ist(2026, 10, 6);

function expectCode(fn: () => unknown, code: LicenseTermsError["code"]): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LicenseTermsError);
    expect((err as LicenseTermsError).code).toBe(code);
    return;
  }
  throw new Error(`Expected LicenseTermsError ${code}`);
}

describe("newLicenseTerms", () => {
  it("annual: expiresAt = paidAt + 365 days and updates run with it", () => {
    const t = newLicenseTerms(annual, 1, paidAt);
    expect(t.expiresAt?.getTime()).toBe(paidAt.getTime() + 365 * DAY_MS);
    expect(t.updatesUntil.getTime()).toBe(t.expiresAt?.getTime());
    expect(t.updatesUntil).not.toBe(t.expiresAt);
    expect(t).toMatchObject({ deviceLimit: 3, status: "ACTIVE" });
  });

  it("one-time: expiresAt null, updatesUntil + 12 calendar months", () => {
    const t = newLicenseTerms(oneTime, 1, paidAt);
    expect(t.expiresAt).toBeNull();
    expect(t.updatesUntil).toEqual(ist(2027, 10, 6));
    expect(t).toMatchObject({ deviceLimit: 1, status: "ACTIVE" });
    expect(newLicenseTerms(plan({ type: "ONE_TIME", updatesMonths: 24 }), 1, paidAt).updatesUntil).toEqual(ist(2028, 10, 6));
    expect(newLicenseTerms(plan({ type: "ONE_TIME" }), 1, paidAt).updatesUntil).toEqual(ist(2027, 10, 6));
  });

  it("subscription: one calendar month or year, per-unit device limit", () => {
    const m = newLicenseTerms(monthly, 4, paidAt);
    expect(m.expiresAt).toEqual(ist(2026, 11, 6));
    expect(m.updatesUntil).toEqual(ist(2026, 11, 6));
    expect(m).toMatchObject({ deviceLimit: 4, status: "ACTIVE" });
    expect(newLicenseTerms(yearly, 2, paidAt).expiresAt).toEqual(ist(2027, 10, 6));
  });

  it("trial: + trialDays (default 15) with TRIAL status", () => {
    const t = newLicenseTerms(trial, 1, paidAt);
    expect(t.expiresAt).toEqual(addDays(paidAt, 7));
    expect(t.updatesUntil).toEqual(addDays(paidAt, 7));
    expect(t).toMatchObject({ deviceLimit: 1, status: "TRIAL" });
    expect(newLicenseTerms(plan({ type: "TRIAL" }), 1, paidAt).expiresAt).toEqual(addDays(paidAt, 15));
  });

  it("defaults the device limit to 1 and uses qty only for per-unit plans", () => {
    expect(newLicenseTerms(plan({ type: "ANNUAL" }), 1, paidAt).deviceLimit).toBe(1);
    expect(newLicenseTerms(multi, 1, paidAt).deviceLimit).toBe(5);
  });

  it("clamps calendar months to the month end in IST", () => {
    expect(newLicenseTerms(monthly, 1, ist(2026, 1, 31)).expiresAt).toEqual(ist(2026, 2, 28));
    expect(newLicenseTerms(monthly, 1, ist(2028, 1, 31)).expiresAt).toEqual(ist(2028, 2, 29));
    expect(newLicenseTerms(yearly, 1, ist(2028, 2, 29)).expiresAt).toEqual(ist(2029, 2, 28));
    expect(newLicenseTerms(oneTime, 1, ist(2026, 3, 31)).updatesUntil).toEqual(ist(2027, 3, 31));
  });

  it("does calendar arithmetic on the IST date, not the UTC date", () => {
    // 31 Jan 2026 20:00 UTC is already 1 Feb 01:30 in India, so one month later is 1 Mar, not 28 Feb.
    const at = new Date(Date.UTC(2026, 0, 31, 20, 0));
    const t = newLicenseTerms(monthly, 1, at);
    expect(istParts(t.expiresAt ?? at)).toMatchObject({ year: 2026, month: 3, day: 1, hour: 1, minute: 30 });
  });

  it("refuses add-on and maintenance plans, which need a target license", () => {
    expectCode(() => newLicenseTerms(addon, 1, paidAt), "needs_target_license");
    expectCode(() => newLicenseTerms(amc, 1, paidAt), "needs_target_license");
  });

  it("refuses bad quantities, a subscription without interval and an invalid date", () => {
    for (const qty of [0, -1, 1.5, Number.NaN]) expectCode(() => newLicenseTerms(annual, qty, paidAt), "invalid_quantity");
    expectCode(() => newLicenseTerms(plan({ type: "SUBSCRIPTION" }), 1, paidAt), "invalid_plan");
    expect(() => newLicenseTerms(annual, 1, new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("renewalTerms", () => {
  const lic = (over: Partial<LicenseTerms> = {}): LicenseTerms => ({
    expiresAt: addDays(paidAt, 41),
    updatesUntil: addDays(paidAt, 41),
    deviceLimit: 3,
    ...over,
  });

  it("early annual renewal extends from the current end date, keeping unused time", () => {
    const current = lic();
    const t = renewalTerms(current, annual, 1, paidAt);
    expect(t.expiresAt?.getTime()).toBe(addDays(paidAt, 41).getTime() + 365 * DAY_MS);
    expect(t.updatesUntil).toEqual(t.expiresAt);
    expect(t.deviceLimit).toBe(3);
  });

  it("late annual renewal starts at payment", () => {
    const t = renewalTerms(lic({ expiresAt: addDays(paidAt, -10), updatesUntil: addDays(paidAt, -10) }), annual, 1, paidAt);
    expect(t.expiresAt?.getTime()).toBe(paidAt.getTime() + 365 * DAY_MS);
    expect(t.updatesUntil).toEqual(t.expiresAt);
  });

  it("keeps a later updatesUntil than the new end date", () => {
    const far = addDays(paidAt, 900);
    const t = renewalTerms(lic({ updatesUntil: far }), annual, 1, paidAt);
    expect(t.updatesUntil).toEqual(far);
  });

  it("subscription renewal adds one calendar interval from max(paidAt, expiresAt), clamped", () => {
    const t = renewalTerms(lic({ expiresAt: ist(2027, 1, 31), updatesUntil: ist(2027, 1, 31), deviceLimit: 2 }), monthly, 2, ist(2027, 1, 20));
    expect(t.expiresAt).toEqual(ist(2027, 2, 28));
    expect(t.updatesUntil).toEqual(ist(2027, 2, 28));
    const late = renewalTerms(lic({ expiresAt: ist(2026, 9, 1) }), yearly, 1, paidAt);
    expect(late.expiresAt).toEqual(ist(2027, 10, 6));
  });

  it("per-unit renewal sets the device limit to the renewed quantity; other plans keep it", () => {
    expect(renewalTerms(lic({ deviceLimit: 2 }), monthly, 4, paidAt).deviceLimit).toBe(4);
    expect(renewalTerms(lic({ deviceLimit: 5 }), yearly, 3, paidAt).deviceLimit).toBe(3);
    expect(renewalTerms(lic({ deviceLimit: 5 }), annual, 1, paidAt).deviceLimit).toBe(5);
  });

  it("maintenance moves only updatesUntil, 12 months from max(paidAt, updatesUntil)", () => {
    const lapsed = { expiresAt: null, updatesUntil: ist(2026, 3, 20), deviceLimit: 1 };
    const t = renewalTerms(lapsed, amc, 1, paidAt);
    expect(t).toEqual({ expiresAt: null, updatesUntil: ist(2027, 10, 6), deviceLimit: 1 });

    const current = { expiresAt: null, updatesUntil: ist(2027, 1, 31), deviceLimit: 3 };
    expect(renewalTerms(current, amc, 1, paidAt)).toEqual({ expiresAt: null, updatesUntil: ist(2028, 1, 31), deviceLimit: 3 });
    expect(renewalTerms(current, amc, 2, paidAt).updatesUntil).toEqual(ist(2029, 1, 31));
    expect(renewalTerms({ ...current, updatesUntil: ist(2027, 2, 28) }, amc, 1, ist(2027, 2, 28, 9)).updatesUntil).toEqual(
      ist(2028, 2, 28),
    );
  });

  it("refuses maintenance on a time-limited license, which would deliver nothing", () => {
    // med-annual license ending 1 Jan 2027: moving updatesUntil past the end date would not unlock any download.
    const annualLicense = lic({ expiresAt: ist(2027, 1, 1), updatesUntil: ist(2027, 1, 1) });
    expectCode(() => renewalTerms(annualLicense, amc, 1, paidAt), "not_renewable");
    expectCode(() => renewalTerms(lic({ expiresAt: addDays(paidAt, -30) }), amc, 1, paidAt), "not_renewable");
  });

  it("refuses plans that cannot renew, and annual renewal of a perpetual license", () => {
    expectCode(() => renewalTerms(lic(), oneTime, 1, paidAt), "not_renewable");
    expectCode(() => renewalTerms(lic(), trial, 1, paidAt), "not_renewable");
    expectCode(() => renewalTerms(lic(), addon, 1, paidAt), "not_renewable");
    expectCode(() => renewalTerms(lic({ expiresAt: null }), annual, 1, paidAt), "not_renewable");
    expectCode(() => renewalTerms(lic(), annual, 0, paidAt), "invalid_quantity");
  });

  it("never mutates the input", () => {
    const current = lic();
    const snapshot = { ...current, expiresAt: new Date(current.expiresAt?.getTime() ?? 0), updatesUntil: new Date(current.updatesUntil.getTime()) };
    renewalTerms(current, annual, 1, paidAt);
    expect(current).toEqual(snapshot);
    const perpetual = { expiresAt: null, updatesUntil: ist(2027, 1, 31), deviceLimit: 1 };
    renewalTerms(perpetual, amc, 1, paidAt);
    expect(perpetual).toEqual({ expiresAt: null, updatesUntil: ist(2027, 1, 31), deviceLimit: 1 });
  });
});

describe("addonTerms", () => {
  it("adds device slots and keeps the dates", () => {
    const current: LicenseTerms = { expiresAt: addDays(paidAt, 41), updatesUntil: addDays(paidAt, 41), deviceLimit: 1 };
    const t = addonTerms(current, 2);
    expect(t).toEqual({ expiresAt: current.expiresAt, updatesUntil: current.updatesUntil, deviceLimit: 3 });
    expect(t.updatesUntil).not.toBe(current.updatesUntil);
    expectCode(() => addonTerms(current, 0), "invalid_quantity");
  });
});

describe("upgradeTerms", () => {
  const trialLic = { status: "TRIAL" as const, expiresAt: addDays(paidAt, -25), updatesUntil: addDays(paidAt, -25), deviceLimit: 1 };
  const annualLic = { status: "ACTIVE" as const, expiresAt: addDays(paidAt, 100), updatesUntil: addDays(paidAt, 100), deviceLimit: 3 };

  it("trial to a paid plan gets that plan's fresh terms and becomes ACTIVE", () => {
    expect(upgradeTerms(trialLic, annual, 1, paidAt)).toEqual({ ...newLicenseTerms(annual, 1, paidAt), status: "ACTIVE" });
    expect(upgradeTerms(trialLic, oneTime, 1, paidAt)).toEqual({
      expiresAt: null,
      updatesUntil: ist(2027, 10, 6),
      deviceLimit: 1,
      status: "ACTIVE",
    });
    expect(upgradeTerms(trialLic, monthly, 3, paidAt)).toMatchObject({ expiresAt: ist(2026, 11, 6), deviceLimit: 3, status: "ACTIVE" });
  });

  it("annual or subscription to one-time drops the end date and extends updates", () => {
    const t = upgradeTerms(annualLic, multi, 1, paidAt);
    expect(t.expiresAt).toBeNull();
    expect(t.updatesUntil).toEqual(addCalendarMonthsIst(annualLic.updatesUntil, 12));
    expect(t.deviceLimit).toBe(5);
    expect(t.status).toBe("ACTIVE");
    expect(upgradeTerms(annualLic, oneTime, 1, paidAt).deviceLimit).toBe(3);
    const lapsed = { ...annualLic, expiresAt: addDays(paidAt, -5), updatesUntil: addDays(paidAt, -5) };
    expect(upgradeTerms(lapsed, oneTime, 1, paidAt).updatesUntil).toEqual(ist(2027, 10, 6));
    expect(upgradeTerms({ ...annualLic, planType: "SUBSCRIPTION" }, oneTime, 1, paidAt).expiresAt).toBeNull();
  });

  it("throws unsupported_upgrade for everything else", () => {
    expectCode(() => upgradeTerms(trialLic, trial, 1, paidAt), "unsupported_upgrade");
    expectCode(() => upgradeTerms(trialLic, amc, 1, paidAt), "unsupported_upgrade");
    expectCode(() => upgradeTerms(trialLic, addon, 1, paidAt), "unsupported_upgrade");
    expectCode(() => upgradeTerms(annualLic, annual, 1, paidAt), "unsupported_upgrade");
    expectCode(() => upgradeTerms(annualLic, yearly, 1, paidAt), "unsupported_upgrade");
    expectCode(() => upgradeTerms({ ...annualLic, expiresAt: null }, oneTime, 1, paidAt), "unsupported_upgrade");
    expectCode(() => upgradeTerms({ ...annualLic, planType: "ONE_TIME" }, oneTime, 1, paidAt), "unsupported_upgrade");
    expectCode(() => upgradeTerms({ ...annualLic, status: "SUSPENDED" }, oneTime, 1, paidAt), "unsupported_upgrade");
    expectCode(() => upgradeTerms({ ...annualLic, status: "REVOKED" }, oneTime, 1, paidAt), "unsupported_upgrade");
    expectCode(() => upgradeTerms({ ...trialLic, status: "REVOKED" }, annual, 1, paidAt), "unsupported_upgrade");
  });
});

/** Independent of the module under test: shift the IST calendar date by whole months (no clamping needed here). */
function addCalendarMonthsIst(d: Date, months: number): Date {
  const p = istParts(d);
  const total = p.year * 12 + (p.month - 1) + months;
  return fromIstParts({ ...p, year: Math.floor(total / 12), month: (total % 12) + 1 });
}
