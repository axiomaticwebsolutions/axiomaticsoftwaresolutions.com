/**
 * Derived license status as shown in the portal and admin console. EXPIRED and EXPIRING are never stored;
 * they come from expiresAt. Pure and client-safe.
 */
import { LicenseStatus } from "@/generated/prisma/enums";
import { DAY_MS, istCalendarYear } from "@/lib/dates";
import type { IconSourceName } from "@/components/icons/icon-names";
import type { Tone } from "@/lib/design/tokens";

export const EXPIRING_DAYS = 60;
export const SELF_SERVICE_RESETS_PER_YEAR = 3;

export type DerivedLicenseStatus = "active" | "trial" | "expiring" | "expired" | "suspended" | "revoked";

export const DERIVED_LICENSE_STATUSES = [
  "active",
  "expiring",
  "expired",
  "trial",
  "suspended",
  "revoked",
] as const satisfies readonly DerivedLicenseStatus[];

export type LicenseStatusMeta = {
  /** Portal badge label. */
  label: string;
  /** Admin console badge label (the console says "Expiring" where the portal says "Expiring soon"). */
  adminLabel: string;
  tone: Tone;
  /** Material Symbols name used by the portal license header (checked against the icon registry). */
  icon: IconSourceName;
  /** Counts toward usable licenses: KPIs, free slots, device deactivation, adding computers. */
  usable: boolean;
};

/** Labels, tones and icons from the portal (LB + license header) and admin (LS) prototypes. */
export const LICENSE_STATUS_META: Record<DerivedLicenseStatus, LicenseStatusMeta> = {
  active: { label: "Active", adminLabel: "Active", tone: "sage", icon: "verified", usable: true },
  expiring: { label: "Expiring soon", adminLabel: "Expiring", tone: "peach", icon: "event_upcoming", usable: true },
  expired: { label: "Expired", adminLabel: "Expired", tone: "peach", icon: "event_busy", usable: false },
  trial: { label: "Trial", adminLabel: "Trial", tone: "blue", icon: "timer", usable: true },
  suspended: { label: "Suspended", adminLabel: "Suspended", tone: "pink", icon: "pause_circle", usable: false },
  revoked: { label: "Revoked", adminLabel: "Revoked", tone: "pink", icon: "block", usable: false },
};

/** An end date at or before `now` has passed (a license is valid strictly before expiresAt). */
export function isExpired(license: { expiresAt: Date | null }, now: Date): boolean {
  return license.expiresAt !== null && license.expiresAt.getTime() <= now.getTime();
}

/**
 * Same precedence as the prototype's licStatus(): revoked/suspended, then expired, then trial,
 * then expiring (ends within EXPIRING_DAYS), else active.
 */
export function deriveLicenseStatus(
  license: { status: LicenseStatus; expiresAt: Date | null },
  now: Date,
): DerivedLicenseStatus {
  if (license.status === LicenseStatus.REVOKED) return "revoked";
  if (license.status === LicenseStatus.SUSPENDED) return "suspended";
  if (isExpired(license, now)) return "expired";
  if (license.status === LicenseStatus.TRIAL) return "trial";
  if (license.expiresAt && license.expiresAt.getTime() - now.getTime() < EXPIRING_DAYS * DAY_MS) return "expiring";
  return "active";
}

export function isUsableLicense(license: { status: LicenseStatus; expiresAt: Date | null }, now: Date): boolean {
  return LICENSE_STATUS_META[deriveLicenseStatus(license, now)].usable;
}

/** Whether the license still receives updates (downloads of releases published up to updatesUntil). */
export function updatesActive(license: { updatesUntil: Date }, now: Date): boolean {
  return now.getTime() < license.updatesUntil.getTime();
}

type ResetCounter = { selfServiceResets: number; resetsYear: number };

/** Self-service device deactivations left this IST calendar year; the stored counter applies to resetsYear only. */
export function selfServiceResetsLeft(
  license: ResetCounter,
  now: Date,
  limitPerYear: number = SELF_SERVICE_RESETS_PER_YEAR,
): number {
  const used = license.resetsYear === istCalendarYear(now) ? license.selfServiceResets : 0;
  return Math.max(0, limitPerYear - used);
}

/**
 * Counter values to persist after one more self-service deactivation, or null when the yearly limit is used up.
 * Persist with a conditional update (WHERE selfServiceResets/resetsYear still match) so concurrent requests
 * cannot both take the last slot.
 */
export function consumeSelfServiceReset(
  license: ResetCounter,
  now: Date,
  limitPerYear: number = SELF_SERVICE_RESETS_PER_YEAR,
): ResetCounter | null {
  if (selfServiceResetsLeft(license, now, limitPerYear) <= 0) return null;
  const year = istCalendarYear(now);
  const used = license.resetsYear === year ? license.selfServiceResets : 0;
  return { selfServiceResets: used + 1, resetsYear: year };
}

/** Portal copy when the yearly self-service limit is used up (429 reset_limit). */
export function selfServiceLimitMessage(limitPerYear: number = SELF_SERVICE_RESETS_PER_YEAR): string {
  return `You\u2019ve used all ${limitPerYear} self-service deactivations this year. Contact support to reset devices.`;
}
