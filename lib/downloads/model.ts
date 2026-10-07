/**
 * Download options shared by the order page (client), the portal software view and the download routes: which
 * published release a license may download, the files of a release, and the copy around download links.
 * Pure and client-safe (no server imports). The server repeats every check when a link is requested.
 */
import { LicenseStatus, ReleaseStatus } from "@/generated/prisma/enums";
import {
  compareVersions,
  ENTITLEMENT_MESSAGES,
  latestEligibleRelease,
  pickEntitlingLicense,
  type DownloadDenial,
  type EntitlementLicense,
} from "@/lib/licensing/entitlement";
import type { DerivedLicenseStatus } from "@/lib/licensing/status";
import type { Platform } from "@/lib/storefront/types";
import { formatFileSize, PLATFORM_LABELS } from "@/lib/storefront/derive";

/** One installer of a release, as the client sees it (never the storage key). */
export type DownloadFileView = {
  id: string;
  platform: string;
  platformLabel: string;
  fileName: string;
  sizeBytes: number;
  sizeLabel: string;
};

/** A published release with its installers (newest first in every list). */
export type DownloadReleaseView = { id: string; version: string; releasedAt: string; files: DownloadFileView[] };

/** Body of a successful POST /api/account/downloads or /api/orders/:id/downloads (contract: `{ url, expiresAt }`). */
export type DownloadLinkResponse = {
  url: string;
  expiresAt: string;
  ttlSec: number;
  fileId: string;
  fileName: string;
  platform: string;
  version: string;
  sizeLabel: string;
  licenseId: string;
};

/** Shape of a release file id in request bodies (cuid, or the seed's readable ids). */
export const RELEASE_FILE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const PLATFORM_ORDER: readonly string[] = ["windows", "macos", "android"];

export function platformLabel(platform: string): string {
  return Object.hasOwn(PLATFORM_LABELS, platform) ? PLATFORM_LABELS[platform as Platform] : platform;
}

export function toDownloadFile(file: { id: string; platform: string; fileName: string; sizeBytes: bigint | number }): DownloadFileView {
  const sizeBytes = Number(file.sizeBytes);
  return {
    id: file.id,
    platform: file.platform,
    platformLabel: platformLabel(file.platform),
    fileName: file.fileName,
    sizeBytes,
    sizeLabel: formatFileSize(sizeBytes),
  };
}

/** Windows, macOS, Android, then anything else by name. */
export function sortDownloadFiles<T extends { platform: string; fileName: string }>(files: readonly T[]): T[] {
  const rank = (p: string) => {
    const i = PLATFORM_ORDER.indexOf(p);
    return i < 0 ? PLATFORM_ORDER.length : i;
  };
  return [...files].sort((a, b) => rank(a.platform) - rank(b.platform) || a.fileName.localeCompare(b.fileName));
}

/** The size the storefront and order page show for a release: the Windows installer, else the first file. */
export function primaryFile<T extends { platform: string }>(files: readonly T[]): T | null {
  return files.find((f) => f.platform === "windows") ?? files[0] ?? null;
}

function time(value: Date | string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const t = (typeof value === "string" ? new Date(value) : value).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Sort comparator, newest first, in the same order as latestEligibleRelease(): releases without a (valid) release
 * date last, then the highest version first (semver: a 4.1.5 hotfix published after 4.2.0 still sorts below it), then
 * the later release date.
 */
export function compareReleasesNewestFirst(
  a: { releasedAt: Date | string | null; version: string },
  b: { releasedAt: Date | string | null; version: string },
): number {
  const ta = time(a.releasedAt);
  const tb = time(b.releasedAt);
  const aDated = ta !== Number.NEGATIVE_INFINITY;
  const bDated = tb !== Number.NEGATIVE_INFINITY;
  if (aDated !== bDated) return aDated ? -1 : 1;
  const byVersion = compareVersions(b.version, a.version);
  if (byVersion !== 0) return byVersion;
  if (ta === tb) return 0;
  return tb > ta ? 1 : -1;
}

/** License fields as the order status DTO (derived status, ISO dates) or the database (stored status, Dates) carry them. */
export type DownloadLicenseLike = {
  status: LicenseStatus | DerivedLicenseStatus;
  expiresAt: Date | string | null;
  updatesUntil: Date | string;
};

const STORED_STATUS: Readonly<Record<DerivedLicenseStatus, LicenseStatus>> = {
  active: LicenseStatus.ACTIVE,
  expiring: LicenseStatus.ACTIVE,
  // Expiry comes from expiresAt; the stored status of an expired license is ACTIVE or TRIAL, both read the same.
  expired: LicenseStatus.ACTIVE,
  trial: LicenseStatus.TRIAL,
  suspended: LicenseStatus.SUSPENDED,
  revoked: LicenseStatus.REVOKED,
};

const asDate = (value: Date | string) => (typeof value === "string" ? new Date(value) : value);

export function toEntitlementLicense(license: DownloadLicenseLike): EntitlementLicense {
  const status = Object.hasOwn(STORED_STATUS, license.status)
    ? STORED_STATUS[license.status as DerivedLicenseStatus]
    : (license.status as LicenseStatus);
  return {
    status,
    expiresAt: license.expiresAt === null ? null : asDate(license.expiresAt),
    updatesUntil: asDate(license.updatesUntil),
  };
}

export type DownloadOption =
  | { ok: true; release: DownloadReleaseView }
  | { ok: false; reason: DownloadDenial; message: string };

/**
 * The newest published release this license may download (with its files), or the reason it may download none:
 * the license's own state first (revoked, suspended, expired), else updates_ended against the newest release, else
 * not_released when nothing is published yet. `releases` are published releases only.
 */
export function downloadOptionFor(license: DownloadLicenseLike, releases: readonly DownloadReleaseView[], now: Date): DownloadOption {
  const ent = toEntitlementLicense(license);
  const candidates = releases.map((view) => ({
    view,
    version: view.version,
    status: ReleaseStatus.PUBLISHED,
    releasedAt: new Date(view.releasedAt),
  }));
  const best = latestEligibleRelease(candidates, ent, now);
  if (best) return { ok: true, release: best.view };
  const newest = [...candidates].sort(compareReleasesNewestFirst)[0];
  let reason: DownloadDenial = "not_released";
  if (newest) {
    const pick = pickEntitlingLicense([ent], newest, now);
    if (!pick.ok) reason = pick.reason;
  }
  return { ok: false, reason, message: ENTITLEMENT_MESSAGES[reason] };
}

// ---------- Copy ----------

/** Whole minutes of a link lifetime, for copy (rounded down, at least 1). */
export function linkMinutes(ttlSec: number): number {
  return Math.max(1, Math.floor(ttlSec / 60));
}

export function minutesText(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Order.dc.html linkNote. */
export function downloadLinkNote(minutes: number): string {
  return `Secure link \u00B7 expires ${minutesText(minutes)} after you click`;
}

/** Shown once the link exists and the browser starts the download (Order.dc.html flash, without "(mock)"). */
export function downloadLinkCreatedMessage(minutes: number): string {
  return `Download link created: valid for ${minutesText(minutes)}`;
}

/** "Download v4.2.1 · 148 MB", or with the platform when a release has several installers. */
export function downloadButtonLabel(version: string, file: Pick<DownloadFileView, "platformLabel" | "sizeLabel">, several: boolean): string {
  const size = file.sizeLabel ? ` \u00B7 ${file.sizeLabel}` : "";
  return several ? `Download v${version} for ${file.platformLabel}${size}` : `Download v${version}${size}`;
}

export const TEAM_CANNOT_DOWNLOAD_MESSAGE = "Your team role can\u2019t download software. Ask the account owner.";
