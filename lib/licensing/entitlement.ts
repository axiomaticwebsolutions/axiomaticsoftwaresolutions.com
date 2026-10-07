/**
 * Download entitlement (api-contracts section 5): license status in {ACTIVE, TRIAL}, not expired, and the release
 * is PUBLISHED with releasedAt <= license.updatesUntil. Pure; the download route adds session, team role and
 * account scoping before calling this.
 */
import { LicenseStatus, ReleaseStatus } from "@/generated/prisma/enums";
import { isExpired } from "./status";

/** Release channel offered to customers: /validate, the portal, the order page and download links (decisions.md Phase 4). */
export const STABLE_CHANNEL = "stable";

export type EntitlementFailure = "revoked" | "suspended" | "expired" | "updates_ended" | "not_released";
/** EntitlementFailure plus the case where the customer holds no license for the product at all. */
export type DownloadDenial = EntitlementFailure | "no_license";

export type EntitlementResult = { ok: true } | { ok: false; reason: EntitlementFailure };

export type EntitlementLicense = { status: LicenseStatus; expiresAt: Date | null; updatesUntil: Date };
export type EntitlementRelease = { status: ReleaseStatus; releasedAt: Date | null };

export type PickResult<L> =
  | { ok: true; license: L }
  | { ok: false; reason: DownloadDenial; license: L | null };

/** Customer-facing copy for a 403 not_entitled, in the portal's wording where the prototype has it. */
export const ENTITLEMENT_MESSAGES: Record<DownloadDenial, string> = {
  revoked:
    "License revoked. It can\u2019t be used to download software. Contact support if you think this is a mistake.",
  suspended: "License suspended. Downloads are paused. Contact support to restore it.",
  expired: "Downloads need an active license. Renew to continue where you left off.",
  updates_ended:
    "Newer version needs renewal. Your updates have ended; the software keeps working, and you can renew maintenance for newer versions.",
  not_released: "This version isn\u2019t available for download yet.",
  no_license: "Buy a license or start a free trial to download software.",
};

/** Failures in order of usefulness to the customer: something they can renew beats something they cannot. */
const FAILURE_RANK: Record<EntitlementFailure, number> = {
  updates_ended: 0,
  expired: 1,
  suspended: 2,
  revoked: 3,
  not_released: 4,
};

function isReleased(release: EntitlementRelease, now: Date): release is EntitlementRelease & { releasedAt: Date } {
  return (
    release.status === ReleaseStatus.PUBLISHED &&
    release.releasedAt !== null &&
    release.releasedAt.getTime() <= now.getTime()
  );
}

/** License-level failure, independent of any release. */
function licenseFailure(license: EntitlementLicense, now: Date): EntitlementFailure | null {
  if (license.status === LicenseStatus.REVOKED) return "revoked";
  if (license.status === LicenseStatus.SUSPENDED) return "suspended";
  if (isExpired(license, now)) return "expired";
  return null;
}

export function checkDownloadEntitlement(
  license: EntitlementLicense,
  release: EntitlementRelease,
  now: Date,
): EntitlementResult {
  const failure = licenseFailure(license, now);
  if (failure) return { ok: false, reason: failure };
  if (!isReleased(release, now)) return { ok: false, reason: "not_released" };
  if (release.releasedAt.getTime() > license.updatesUntil.getTime()) return { ok: false, reason: "updates_ended" };
  return { ok: true };
}

function laterCoverage(a: EntitlementLicense, b: EntitlementLicense): boolean {
  const byUpdates = a.updatesUntil.getTime() - b.updatesUntil.getTime();
  if (byUpdates !== 0) return byUpdates > 0;
  // Same updates window: prefer the license that runs longer (perpetual first).
  const aEnd = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return aEnd > bEnd;
}

/**
 * Chooses the license to record on DownloadEvent: an entitled one with the latest updatesUntil. When none is
 * entitled, returns the most informative failure (and the license it belongs to) for the 403 response.
 */
export function pickEntitlingLicense<L extends EntitlementLicense>(
  licenses: readonly L[],
  release: EntitlementRelease,
  now: Date,
): PickResult<L> {
  if (licenses.length === 0) return { ok: false, reason: "no_license", license: null };
  if (!isReleased(release, now)) return { ok: false, reason: "not_released", license: null };

  let best: L | null = null;
  let fallback: { reason: EntitlementFailure; license: L } | null = null;
  for (const license of licenses) {
    const result = checkDownloadEntitlement(license, release, now);
    if (result.ok) {
      if (!best || laterCoverage(license, best)) best = license;
      continue;
    }
    const rank = FAILURE_RANK[result.reason];
    if (
      !fallback ||
      rank < FAILURE_RANK[fallback.reason] ||
      (rank === FAILURE_RANK[fallback.reason] && laterCoverage(license, fallback.license))
    ) {
      fallback = { reason: result.reason, license };
    }
  }
  if (best) return { ok: true, license: best };
  // Non-empty input and no entitled license means at least one failure was recorded.
  return fallback
    ? { ok: false, reason: fallback.reason, license: fallback.license }
    : { ok: false, reason: "no_license", license: null };
}

const NUMERIC_IDENTIFIER = /^\d+$/;

/** Numeric strings of any length compared by value (no precision loss), e.g. build counters like "20261007". */
function compareNumeric(x: string, y: string): number {
  const a = x.replace(/^0+(?=\d)/, "");
  const b = y.replace(/^0+(?=\d)/, "");
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a > b ? 1 : a < b ? -1 : 0;
}

/** One dot-separated identifier: numbers by value, numbers below text (semver), text in ASCII order. */
function compareIdentifier(x: string, y: string): number {
  const xNum = NUMERIC_IDENTIFIER.test(x);
  const yNum = NUMERIC_IDENTIFIER.test(y);
  if (xNum && yNum) return compareNumeric(x, y);
  if (xNum) return -1;
  if (yNum) return 1;
  return x > y ? 1 : x < y ? -1 : 0;
}

function parseVersion(version: string): { core: string[]; pre: string[] | null } {
  const withoutBuild = version.trim().split("+")[0] ?? "";
  const dash = withoutBuild.indexOf("-");
  const core = (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)).split(".");
  return { core, pre: dash < 0 ? null : withoutBuild.slice(dash + 1).split(".") };
}

/**
 * Semantic-version precedence (semver 2.0 section 11), also for the 2-4 part versions apps send ("4.2", "4.2.1.1830"):
 * the numeric core part by part (a missing part counts as 0, so "4.2" equals "4.2.0"), then a version without a
 * pre-release ranks above the same version with one ("4.3.0" > "4.3.0-beta.2"), pre-release identifiers compare
 * numerically or in ASCII order with numbers below text, and build metadata ("+20261007") is ignored.
 * Returns 1, 0 or -1.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i += 1) {
    const diff = compareIdentifier(pa.core[i] ?? "0", pb.core[i] ?? "0");
    if (diff !== 0) return diff;
  }
  if (pa.pre === null || pb.pre === null) return pa.pre === pb.pre ? 0 : pa.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    // A longer pre-release with an equal prefix ranks higher ("beta.1" > "beta").
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const diff = compareIdentifier(x, y);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * True when release `a` is newer than `b`: the higher version wins (a 4.1.5 hotfix published after 4.2.0 is still
 * older than 4.2.0); the release date only breaks ties between equal versions, or decides when a version is missing.
 */
export function isNewerRelease(
  a: { version?: string; releasedAt: Date },
  b: { version?: string; releasedAt: Date },
): boolean {
  if (a.version !== undefined && b.version !== undefined) {
    const byVersion = compareVersions(a.version, b.version);
    if (byVersion !== 0) return byVersion > 0;
  }
  return a.releasedAt.getTime() > b.releasedAt.getTime();
}

/**
 * Newest release this license may download (latestEligibleVersion in /validate, "Eligible version" in the
 * portal), or null when the license itself is not entitled or no release qualifies. "Newest" means the highest
 * version among the released releases the license covers (releasedAt <= updatesUntil), not the latest release date.
 */
export function latestEligibleRelease<R extends EntitlementRelease & { version?: string }>(
  releases: readonly R[],
  license: EntitlementLicense,
  now: Date,
): R | null {
  let best: (R & { releasedAt: Date }) | null = null;
  for (const release of releases) {
    if (!checkDownloadEntitlement(license, release, now).ok || !isReleased(release, now)) continue;
    if (!best || isNewerRelease(release, best)) best = release;
  }
  return best;
}
