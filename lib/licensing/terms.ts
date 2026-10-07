/**
 * License term arithmetic (docs/decisions.md section 5). Pure: callers pass the base time, which is always
 * Order.paidAt for purchases (never wall-clock time inside webhook retries), and persist the result.
 * Day-based terms add exact 24 h days; calendar terms use IST and clamp to the month end (lib/dates.ts).
 */
import { BillingInterval, LicenseStatus, PlanType } from "@/generated/prisma/enums";
import { addCalendarMonths, addCalendarYears, addDays, maxDate } from "@/lib/dates";

export type TermPlan = {
  type: PlanType;
  interval: BillingInterval | null;
  trialDays: number | null;
  deviceLimit: number | null;
  perUnit: string | null;
  updatesMonths: number | null;
};

export type LicenseTerms = { expiresAt: Date | null; updatesUntil: Date; deviceLimit: number };

export const ANNUAL_TERM_DAYS = 365;
export const DEFAULT_TRIAL_DAYS = 15;
export const DEFAULT_UPDATES_MONTHS = 12;
export const MAINTENANCE_MONTHS_PER_UNIT = 12;

export type LicenseTermsErrorCode =
  | "invalid_quantity"
  | "invalid_plan"
  | "needs_target_license"
  | "not_renewable"
  | "unsupported_upgrade";

/** Thrown for combinations fulfilment must never attempt; `code` is stable for callers and logs. */
export class LicenseTermsError extends Error {
  readonly code: LicenseTermsErrorCode;

  constructor(code: LicenseTermsErrorCode, message: string) {
    super(message);
    this.name = "LicenseTermsError";
    this.code = code;
  }
}

function assertQty(qty: number): void {
  if (!Number.isSafeInteger(qty) || qty < 1) {
    throw new LicenseTermsError("invalid_quantity", `Quantity must be a positive integer, got ${qty}`);
  }
}

function assertDate(at: Date): void {
  if (Number.isNaN(at.getTime())) throw new RangeError("Invalid base date");
}

function copyDate(d: Date): Date {
  return new Date(d.getTime());
}

/** One subscription period after `from`: a calendar month or year in IST. */
function addInterval(from: Date, interval: BillingInterval | null): Date {
  if (interval === BillingInterval.MONTH) return addCalendarMonths(from, 1);
  if (interval === BillingInterval.YEAR) return addCalendarYears(from, 1);
  throw new LicenseTermsError("invalid_plan", "Subscription plan has no billing interval");
}

/** Device slots a plan grants for a quantity: per-unit plans sell slots, the rest use the plan's limit. */
export function planDeviceLimit(plan: Pick<TermPlan, "perUnit" | "deviceLimit">, qty: number): number {
  assertQty(qty);
  return plan.perUnit ? qty : (plan.deviceLimit ?? 1);
}

/** Terms for a license issued by a NEW item, a trial start or a staff manual issue. */
export function newLicenseTerms(
  plan: TermPlan,
  qty: number,
  at: Date,
): LicenseTerms & { status: "ACTIVE" | "TRIAL" } {
  assertDate(at);
  const deviceLimit = planDeviceLimit(plan, qty);
  switch (plan.type) {
    case PlanType.ANNUAL: {
      const expiresAt = addDays(at, ANNUAL_TERM_DAYS);
      return { expiresAt, updatesUntil: copyDate(expiresAt), deviceLimit, status: "ACTIVE" };
    }
    case PlanType.SUBSCRIPTION: {
      const expiresAt = addInterval(at, plan.interval);
      return { expiresAt, updatesUntil: copyDate(expiresAt), deviceLimit, status: "ACTIVE" };
    }
    case PlanType.ONE_TIME:
      return {
        expiresAt: null,
        updatesUntil: addCalendarMonths(at, plan.updatesMonths ?? DEFAULT_UPDATES_MONTHS),
        deviceLimit,
        status: "ACTIVE",
      };
    case PlanType.TRIAL: {
      const expiresAt = addDays(at, plan.trialDays ?? DEFAULT_TRIAL_DAYS);
      return { expiresAt, updatesUntil: copyDate(expiresAt), deviceLimit, status: "TRIAL" };
    }
    case PlanType.DEVICE_ADDON:
    case PlanType.MAINTENANCE:
      throw new LicenseTermsError("needs_target_license", `${plan.type} plans apply to an existing license`);
  }
}

/**
 * Terms after a RENEWAL item. Extends from max(at, current end) so early renewals keep the unused time and late
 * renewals start at payment. MAINTENANCE (a RENEWAL item whose plan type is MAINTENANCE) moves only updatesUntil and
 * is for perpetual licenses only: on an annual or subscription license the end date still blocks downloads, so the
 * customer would pay for nothing (the prototype offers maintenance only for one-time licenses).
 */
export function renewalTerms(license: LicenseTerms, plan: TermPlan, qty: number, at: Date): LicenseTerms {
  assertQty(qty);
  assertDate(at);
  switch (plan.type) {
    case PlanType.MAINTENANCE:
      if (license.expiresAt !== null) {
        throw new LicenseTermsError("not_renewable", "Maintenance plans renew updates for perpetual (one-time) licenses only");
      }
      return {
        expiresAt: null,
        updatesUntil: addCalendarMonths(maxDate(license.updatesUntil, at), MAINTENANCE_MONTHS_PER_UNIT * qty),
        deviceLimit: license.deviceLimit,
      };
    case PlanType.ANNUAL:
    case PlanType.SUBSCRIPTION: {
      // A perpetual license would silently become time-limited; perpetual licenses renew through MAINTENANCE.
      if (license.expiresAt === null) {
        throw new LicenseTermsError("not_renewable", "A perpetual license is renewed with a maintenance plan");
      }
      const base = maxDate(license.expiresAt, at);
      const expiresAt = plan.type === PlanType.ANNUAL ? addDays(base, ANNUAL_TERM_DAYS) : addInterval(base, plan.interval);
      return {
        expiresAt,
        updatesUntil: copyDate(maxDate(license.updatesUntil, expiresAt)),
        deviceLimit: plan.perUnit ? qty : license.deviceLimit,
      };
    }
    case PlanType.ONE_TIME:
    case PlanType.TRIAL:
    case PlanType.DEVICE_ADDON:
      throw new LicenseTermsError("not_renewable", `${plan.type} plans cannot be renewed`);
  }
}

/** Terms after an ADDON item: more device slots, dates unchanged. */
export function addonTerms(license: LicenseTerms, qty: number): LicenseTerms {
  assertQty(qty);
  return {
    expiresAt: license.expiresAt ? copyDate(license.expiresAt) : null,
    updatesUntil: copyDate(license.updatesUntil),
    deviceLimit: license.deviceLimit + qty,
  };
}

/**
 * Terms after an UPGRADE item on the same license (same key and devices; decisions.md section 6).
 * Supported: TRIAL -> any paid plan (fresh terms from `at`), and ANNUAL/SUBSCRIPTION -> ONE_TIME. The current plan
 * type is inferred (a non-trial license with an end date is annual or a subscription) unless `planType` is given.
 */
export function upgradeTerms(
  license: LicenseTerms & { status: LicenseStatus; planType?: PlanType },
  plan: TermPlan,
  qty: number,
  at: Date,
): LicenseTerms & { status: "ACTIVE" } {
  assertQty(qty);
  assertDate(at);
  const paidTarget = plan.type === PlanType.ANNUAL || plan.type === PlanType.SUBSCRIPTION || plan.type === PlanType.ONE_TIME;

  if (license.status === LicenseStatus.TRIAL && paidTarget) {
    const terms = newLicenseTerms(plan, qty, at);
    return { expiresAt: terms.expiresAt, updatesUntil: terms.updatesUntil, deviceLimit: terms.deviceLimit, status: "ACTIVE" };
  }

  const timeLimited =
    license.planType === undefined
      ? license.expiresAt !== null
      : license.planType === PlanType.ANNUAL || license.planType === PlanType.SUBSCRIPTION;
  if (license.status === LicenseStatus.ACTIVE && timeLimited && plan.type === PlanType.ONE_TIME) {
    return {
      expiresAt: null,
      updatesUntil: addCalendarMonths(maxDate(license.updatesUntil, at), plan.updatesMonths ?? DEFAULT_UPDATES_MONTHS),
      deviceLimit: Math.max(license.deviceLimit, planDeviceLimit(plan, qty)),
      status: "ACTIVE",
    };
  }

  throw new LicenseTermsError("unsupported_upgrade", `Cannot upgrade a ${license.status} license to ${plan.type}`);
}
