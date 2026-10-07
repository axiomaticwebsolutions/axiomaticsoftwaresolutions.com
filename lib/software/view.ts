/**
 * "Software & downloads" view model (Customer Portal.dc.html vSoftware; GET /api/account/software, api-contracts
 * section 5). One entry per product the account holds a license for (any status), using the license that unlocks
 * the newest release:
 * - latestRelease: newest published release; eligibleRelease: newest release the account may download;
 * - releases: every published release with notes, files and "Included" / "Needs renewal" (the same
 *   pickEntitlingLicense() rule the download endpoint applies, over all of the account's licenses for the product);
 * - reason + reasonMessage when nothing is downloadable (revoked, suspended, expired, updates_ended, not_released).
 * Pure: Dates in, ISO strings out; lib/software/load.ts reads the database.
 */
import { LicenseStatus, ReleaseStatus, type PlanType } from "@/generated/prisma/enums";
import { formatDateIST } from "@/lib/dates";
import type { Tone } from "@/lib/design/tokens";
import { compareReleasesNewestFirst, primaryFile, type DownloadFileView } from "@/lib/downloads/model";
import {
  ENTITLEMENT_MESSAGES,
  latestEligibleRelease,
  pickEntitlingLicense,
  type DownloadDenial,
  type EntitlementRelease,
} from "@/lib/licensing/entitlement";
import { deriveLicenseStatus, isExpired, LICENSE_STATUS_META, updatesActive, type DerivedLicenseStatus } from "@/lib/licensing/status";

export type SoftwareLicenseInput = {
  id: string;
  productId: string;
  planName: string;
  planType: PlanType;
  status: LicenseStatus;
  expiresAt: Date | null;
  updatesUntil: Date;
};

export type SoftwareReleaseInput = {
  id: string;
  version: string;
  releasedAt: Date;
  notes: readonly string[];
  files: readonly DownloadFileView[];
};

export type SoftwareProductInput = {
  id: string;
  name: string;
  shortName: string;
  icon: string;
  tone: Tone;
  rank: number;
  platforms: readonly string[];
  /** Published releases (any order); future-dated ones are ignored. */
  releases: readonly SoftwareReleaseInput[];
};

export type ReleaseAccess = "included" | "needs_renewal";
export const RELEASE_ACCESS_LABELS: Readonly<Record<ReleaseAccess, string>> = {
  included: "Included",
  needs_renewal: "Needs renewal",
};

export type EligibilityTag = "up_to_date" | "needs_renewal" | "not_eligible" | "no_access";
export const ELIGIBILITY: Readonly<Record<EligibilityTag, { label: string; tone: Tone }>> = {
  up_to_date: { label: "Up to date", tone: "sage" },
  needs_renewal: { label: "Newer version needs renewal", tone: "peach" },
  not_eligible: { label: "Not eligible", tone: "pink" },
  no_access: { label: "No access", tone: "pink" },
};

export type SoftwareReleaseView = {
  id: string;
  version: string;
  releasedAt: string;
  notes: string[];
  files: DownloadFileView[];
  access: ReleaseAccess;
  accessLabel: string;
  /** Why the account cannot download this release (null when included). */
  reason: DownloadDenial | null;
};

export type SoftwareLicenseView = {
  id: string;
  planName: string;
  planType: PlanType;
  status: DerivedLicenseStatus;
  statusLabel: string;
  expiresAt: string | null;
  updatesUntil: string;
};

export type SoftwareProductView = {
  productId: string;
  name: string;
  shortName: string;
  icon: string;
  tone: Tone;
  platforms: string[];
  /** The license this entry describes: the one that unlocks the newest release, else the most useful failure. */
  license: SoftwareLicenseView;
  licenseCount: number;
  latestRelease: { id: string; version: string; releasedAt: string; sizeLabel: string } | null;
  eligibleRelease: { id: string; version: string; releasedAt: string } | null;
  eligibility: { tag: EligibilityTag; label: string; tone: Tone };
  /** "While license is active", "Updates until 7 Oct 2027", "Updates ended 25 Mar 2026", "Ended 11 Sep 2026", ... */
  eligibleNote: string;
  upToDate: boolean;
  /** Some release is downloadable for the account. */
  downloadable: boolean;
  /** downloadable and the viewer's team role has `downloads`. */
  canDownload: boolean;
  reason: DownloadDenial | null;
  reasonMessage: string | null;
  needsRenewal: boolean;
  renewLabel: string | null;
  releases: SoftwareReleaseView[];
};

export type SoftwareView = {
  products: SoftwareProductView[];
  /** The viewer's team role may download (Owner, Technical). */
  canDownload: boolean;
};

type Rel = SoftwareReleaseInput & EntitlementRelease & { releasedAt: Date };

function laterCoverage(a: SoftwareLicenseInput, b: SoftwareLicenseInput): boolean {
  const byUpdates = a.updatesUntil.getTime() - b.updatesUntil.getTime();
  if (byUpdates !== 0) return byUpdates > 0;
  const aEnd = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return aEnd > bEnd;
}

/** Usable licenses first (not revoked, suspended or expired), then the longest updates coverage. */
function preferredFallback(licenses: readonly SoftwareLicenseInput[], now: Date): SoftwareLicenseInput | null {
  const usable = (l: SoftwareLicenseInput) =>
    l.status !== LicenseStatus.REVOKED && l.status !== LicenseStatus.SUSPENDED && !isExpired(l, now);
  let best: SoftwareLicenseInput | null = null;
  for (const l of licenses) {
    if (!best || (usable(l) && !usable(best)) || (usable(l) === usable(best) && laterCoverage(l, best))) best = l;
  }
  return best;
}

type Choice = { license: SoftwareLicenseInput; eligible: Rel | null; reason: DownloadDenial | null };

function chooseLicense(licenses: readonly SoftwareLicenseInput[], releases: readonly Rel[], now: Date): Choice | null {
  let best: { license: SoftwareLicenseInput; eligible: Rel } | null = null;
  for (const license of licenses) {
    const eligible = latestEligibleRelease(releases, license, now);
    if (!eligible) continue;
    const order = best ? compareReleasesNewestFirst(eligible, best.eligible) : -1;
    if (!best || order < 0 || (order === 0 && laterCoverage(license, best.license))) best = { license, eligible };
  }
  if (best) return { ...best, reason: null };

  const newest = releases[0];
  if (newest) {
    const pick = pickEntitlingLicense(licenses, newest, now);
    const license = pick.license ?? preferredFallback(licenses, now);
    if (!license) return null;
    return { license, eligible: null, reason: pick.ok ? null : pick.reason };
  }
  const license = preferredFallback(licenses, now);
  return license ? { license, eligible: null, reason: "not_released" } : null;
}

function eligibleNote(choice: Choice, now: Date): string {
  const { license, reason } = choice;
  if (choice.eligible) {
    if (license.expiresAt) return "While license is active";
    return updatesActive(license, now)
      ? `Updates until ${formatDateIST(license.updatesUntil)}`
      : `Updates ended ${formatDateIST(license.updatesUntil)}`;
  }
  switch (reason) {
    case "revoked":
      return "License revoked";
    case "suspended":
      return "License suspended";
    case "expired":
      return `Ended ${formatDateIST(license.expiresAt)}`;
    case "updates_ended":
      return `Updates ended ${formatDateIST(license.updatesUntil)}`;
    default:
      return "No release available yet";
  }
}

/** Customer Portal.dc.html renewLabel: trials buy a license, perpetual licenses renew maintenance. */
function renewLabel(license: SoftwareLicenseInput, latest: Rel | undefined): string {
  if (license.planType === "TRIAL") return "Buy a license";
  if (license.planType === "ONE_TIME") return latest ? `Renew maintenance for v${latest.version}` : "Renew maintenance";
  return "Renew license";
}

function releaseView(r: Rel, licenses: readonly SoftwareLicenseInput[], now: Date): SoftwareReleaseView {
  const pick = pickEntitlingLicense(licenses, r, now);
  const access: ReleaseAccess = pick.ok ? "included" : "needs_renewal";
  return {
    id: r.id,
    version: r.version,
    releasedAt: r.releasedAt.toISOString(),
    notes: [...r.notes],
    files: [...r.files],
    access,
    accessLabel: RELEASE_ACCESS_LABELS[access],
    reason: pick.ok ? null : pick.reason,
  };
}

function productView(
  product: SoftwareProductInput,
  licenses: readonly SoftwareLicenseInput[],
  now: Date,
  roleCanDownload: boolean,
): SoftwareProductView | null {
  const releases: Rel[] = product.releases
    .filter((r) => r.releasedAt.getTime() <= now.getTime())
    .map((r) => ({ ...r, status: ReleaseStatus.PUBLISHED }))
    .sort(compareReleasesNewestFirst);
  const choice = chooseLicense(licenses, releases, now);
  if (!choice) return null;
  const { license, eligible, reason } = choice;
  const latest = releases[0];
  const upToDate = eligible !== null && latest !== undefined && eligible.id === latest.id;
  const status = deriveLicenseStatus(license, now);
  const tag: EligibilityTag = eligible ? (upToDate ? "up_to_date" : "needs_renewal") : reason === "revoked" ? "no_access" : "not_eligible";
  // Renewing helps when the license or its updates ended; never for revoked or suspended licenses.
  const needsRenewal = eligible ? !upToDate : reason === "expired" || reason === "updates_ended";
  const latestFile = latest ? primaryFile(latest.files) : null;

  return {
    productId: product.id,
    name: product.name,
    shortName: product.shortName,
    icon: product.icon,
    tone: product.tone,
    platforms: [...product.platforms],
    license: {
      id: license.id,
      planName: license.planName,
      planType: license.planType,
      status,
      statusLabel: LICENSE_STATUS_META[status].label,
      expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
      updatesUntil: license.updatesUntil.toISOString(),
    },
    licenseCount: licenses.length,
    latestRelease: latest
      ? { id: latest.id, version: latest.version, releasedAt: latest.releasedAt.toISOString(), sizeLabel: latestFile?.sizeLabel ?? "" }
      : null,
    eligibleRelease: eligible ? { id: eligible.id, version: eligible.version, releasedAt: eligible.releasedAt.toISOString() } : null,
    eligibility: { tag, ...ELIGIBILITY[tag] },
    eligibleNote: eligibleNote(choice, now),
    upToDate,
    downloadable: eligible !== null,
    canDownload: eligible !== null && roleCanDownload,
    reason: eligible ? null : reason,
    reasonMessage: eligible || !reason ? null : ENTITLEMENT_MESSAGES[reason],
    needsRenewal,
    renewLabel: needsRenewal ? renewLabel(license, latest) : null,
    releases: releases.map((r) => releaseView(r, licenses, now)),
  };
}

export function buildSoftwareView(input: {
  licenses: readonly SoftwareLicenseInput[];
  products: readonly SoftwareProductInput[];
  now: Date;
  /** The viewer's team role has `downloads`. */
  canDownload: boolean;
}): SoftwareView {
  const byProduct = new Map<string, SoftwareLicenseInput[]>();
  for (const l of input.licenses) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  const products = [...input.products]
    .filter((p) => byProduct.has(p.id))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map((p) => productView(p, byProduct.get(p.id) ?? [], input.now, input.canDownload))
    .filter((v): v is SoftwareProductView => v !== null);
  return { products, canDownload: input.canDownload };
}
