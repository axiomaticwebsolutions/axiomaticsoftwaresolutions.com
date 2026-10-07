/**
 * "Software & downloads" view model (Customer Portal.dc.html vSoftware) on top of the server's SoftwareView
 * (lib/software/view.ts, GET /api/account/software): download buttons per installer of the eligible release, the
 * lock note, the renewal link, release-note rows and the trial notices for /account/software?trial=<slug>.
 * Pure and client-safe (types only from server modules).
 */
import { licensePath, PORTAL_PATHS } from "@/components/account/portal-nav";
import { formatDateIST } from "@/lib/dates";
import { minutesText, platformLabel } from "@/lib/downloads/model";
import type { SoftwareProductView, SoftwareReleaseView } from "@/lib/software/view";

export const SOFTWARE_COPY = {
  title: "Software & downloads",
  description: (minutes: number) =>
    `Download the latest version each license entitles you to. Links are created on request and expire after ${minutesText(minutes)}.`,
  installGuides: "Installation guides",
  installGuide: "Installation guide",
  releaseNotes: "Release notes",
  eligibleVersion: "Eligible version",
  latestRelease: "Latest release",
  none: "None",
  /** New: a product without a published release yet. */
  noRelease: "No release yet",
  version: "Version",
  released: "Released",
  changes: "Changes",
  access: "Your access",
  emptyTitle: "No software yet",
  emptyBody: "Buy a license or start a free trial to download software.",
  emptyCta: "Browse software",
  creatingLink: "Creating link\u2026",
} as const;

/** "v4.2.1" */
export function versionLabel(version: string): string {
  return `v${version}`;
}

/** "Windows · macOS" */
export function platformsText(platforms: readonly string[]): string {
  return platforms.map(platformLabel).join(" \u00b7 ");
}

/** "15 Sep 2026 · 148 MB" under LATEST RELEASE. */
export function latestNote(latest: SoftwareProductView["latestRelease"]): string {
  if (!latest) return SOFTWARE_COPY.noRelease;
  const date = formatDateIST(new Date(latest.releasedAt));
  return latest.sizeLabel ? `${date} \u00b7 ${latest.sizeLabel}` : date;
}

export type DownloadButton = { fileId: string; version: string; platform: string; label: string; fileName: string; sizeLabel: string };

/**
 * One primary button per installer of the eligible release, "v4.2.1 for Windows" (prototype). Android files are
 * included (decisions.md Phase 5: they download like the other platforms). Empty when nothing is downloadable.
 */
export function downloadButtons(product: Pick<SoftwareProductView, "eligibleRelease" | "releases">): DownloadButton[] {
  const eligible = product.eligibleRelease;
  if (!eligible) return [];
  const release = product.releases.find((r) => r.id === eligible.id);
  if (!release) return [];
  return release.files.map((file) => ({
    fileId: file.id,
    version: release.version,
    platform: file.platform,
    label: `${versionLabel(release.version)} for ${file.platformLabel}`,
    fileName: file.fileName,
    sizeLabel: file.sizeLabel,
  }));
}

/** The footer's lock note: entitlement-checked links, or why nothing can be downloaded. */
export function lockNote(product: Pick<SoftwareProductView, "downloadable" | "reason">, minutes: number): string {
  if (product.downloadable) return `Entitlement-checked \u00b7 links expire in ${minutes} min`;
  // New copy for the two cases the prototype did not have.
  if (product.reason === "not_released") return "No release to download yet";
  if (product.reason === "updates_ended") return "Newer versions need a maintenance renewal";
  return "Downloads need an active license";
}

/** "Renew license" / "Renew maintenance for v3.1.0" / "Buy a license" open the license's Renew & upgrade tab. */
export function renewHref(product: Pick<SoftwareProductView, "license">): string {
  return `${licensePath(product.license.id)}?tab=renew`;
}

/** The prototype's "{plan} · {LIC}" line under the product name. */
export function licenseLine(product: Pick<SoftwareProductView, "license">): string {
  return `${product.license.planName} \u00b7 ${product.license.id}`;
}

/** Release-note rows: version, date, notes joined with " · ", access pill. */
export type ReleaseRow = { id: string; version: string; date: string; dateTime: string; changes: string; access: SoftwareReleaseView["access"]; accessLabel: string };

export function releaseRows(releases: readonly SoftwareReleaseView[]): ReleaseRow[] {
  return releases.map((r) => ({
    id: r.id,
    version: versionLabel(r.version),
    date: formatDateIST(new Date(r.releasedAt)),
    dateTime: r.releasedAt,
    changes: r.notes.join(" \u00b7 "),
    access: r.access,
    accessLabel: r.accessLabel,
  }));
}

/** Prototype toast without "(mock)": "Signed download link for v4.2.1 created · valid 10 minutes". */
export function downloadToast(version: string, minutes: number): string {
  return `Signed download link for ${versionLabel(version)} created \u00b7 valid ${minutesText(minutes)}`;
}

/** Only http(s) URLs are followed (S3/CloudFront or the dev storage route). */
export function safeDownloadUrl(url: unknown, base: string): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    const parsed = new URL(url, base);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export const INSTALL_GUIDE_PATH = PORTAL_PATHS.installGuide;
export const CATALOG_PATH = PORTAL_PATHS.catalog;

// ---------- Free trial from the storefront (/account/software?trial=<slug>) ----------

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The product slug of `?trial=` (first value, trimmed, lower-cased), else null. */
export function trialSlugFrom(value: string | string[] | undefined | null): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  return slug.length > 0 && slug.length <= 80 && SLUG_RE.test(slug) ? slug : null;
}

export type TrialProduct = { id: string; name: string; shortName: string; icon: string; tone: string };

/**
 * What the account can do with the requested trial (server: components/account/software/trial-offer.ts):
 * ready to start, a trial already running, already used (an ended trial, or one converted to a paid license), a
 * working paid license already held (no trial offered), no trial plan, or an unknown / unpublished product. The API repeats every check when the trial is started.
 */
export type TrialOffer =
  | {
      state: "ready";
      slug: string;
      product: TrialProduct;
      planName: string;
      trialDays: number | null;
      deviceLimit: number;
      /** "terminal" for per-unit plans, else "computer". */
      deviceWord: string;
    }
  | { state: "active"; slug: string; product: TrialProduct; licenseId: string; expiresAt: string | null }
  | { state: "used"; slug: string; product: TrialProduct; licenseId: string; licenseIsTrial: boolean; expiresAt: string | null }
  /** New: the account already holds a working paid license of the product, so the notice links to it. */
  | { state: "owned"; slug: string; product: TrialProduct; licenseId: string; planName: string }
  | { state: "unavailable"; slug: string; product: TrialProduct }
  | { state: "not_found"; slug: string };

/** POST /api/account/trials 201 body (lib/portal/trials.ts StartedTrial). */
export type StartedTrialBody = {
  license: {
    id: string;
    productId: string;
    productName: string;
    productShortName: string;
    planName: string;
    status: "trial";
    keyMasked: string;
    issuedAt: string;
    expiresAt: string | null;
    deviceLimit: number;
  };
  href: string;
};

export const TRIALS_API_PATH = "/api/account/trials";

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/** "All features on 1 computer for 15 days." (prototype trial plans: "All features for 15 days on one computer."). */
export function trialTerms(offer: { trialDays: number | null; deviceLimit: number; deviceWord: string }): string {
  const devices = plural(Math.max(1, offer.deviceLimit), offer.deviceWord || "computer");
  return offer.trialDays && offer.trialDays > 0
    ? `All features on ${devices} for ${plural(offer.trialDays, "day")}.`
    : `All features on ${devices}.`;
}

/** New copy for the trial notices and confirm dialog (the prototype never started trials inside the portal). */
export const TRIAL_COPY = {
  startCta: "Start free trial",
  notNow: "Not now",
  dismiss: "Dismiss",
  cancel: "Cancel",
  viewLicense: "View license",
  buyLicense: "Buy a license",
  viewProduct: "View product",
  browse: "Browse software",
  readyTitle: (short: string) => `Start your free trial of ${short}.`,
  readyBody: (terms: string) => `${terms} No payment needed.`,
  dialogTitle: (short: string) => `Start a free trial of ${short}?`,
  dialogBody: (name: string, terms: string, business: string) =>
    `${name} for ${business}. ${terms} If you buy a license later, it keeps the same key and data.`,
  startedTitle: (short: string) => `Your ${short} trial has started.`,
  startedBody: (licenseId: string, expiresAt: string | null) =>
    `${licenseId}${expiresAt ? ` runs until ${formatDateIST(new Date(expiresAt))}` : " is ready"}. Download the software below, then activate it with the key from the license page.`,
  startedToast: (licenseId: string) => `Free trial started \u00b7 ${licenseId}`,
  activeTitle: (short: string) => `Your ${short} trial is already running.`,
  activeBody: (licenseId: string, expiresAt: string | null) =>
    expiresAt ? `${licenseId} ends on ${formatDateIST(new Date(expiresAt))}.` : `${licenseId} is on your account.`,
  /** Same sentence as the API's 409 trial_used (lib/licensing/issue.ts TRIAL_USED_MESSAGE). */
  usedTitle: "You\u2019ve already used the free trial for this product.",
  usedTrialBody: (licenseId: string, expiresAt: string | null) =>
    `Your trial (${licenseId})${expiresAt ? ` ended on ${formatDateIST(new Date(expiresAt))}` : " has ended"}. Buy a license to continue with the same key and data.`,
  usedPaidBody: (licenseId: string) => `${licenseId} is on your account.`,
  ownedTitle: (short: string) => `${short} is already on your account.`,
  ownedBody: (licenseId: string, planName: string) => `${licenseId} (${planName}) is active. Download the software below.`,
  /** Same sentence as the API's 422 trial_unavailable. */
  unavailableTitle: "This product doesn\u2019t offer a free trial.",
  unavailableBody: (short: string) => `See the plans for ${short}, or request a demo.`,
  notFoundTitle: "We couldn\u2019t find that product.",
  notFoundBody: "It may have been renamed or is no longer sold.",
} as const;

/** Where the "Buy a license" of an ended trial goes: the trial's Renew & upgrade tab (UPGRADE keeps key and data). */
export function trialUpgradeHref(licenseId: string): string {
  return `${licensePath(licenseId)}?tab=renew`;
}

export function productPageHref(slug: string): string {
  return `/software/${encodeURIComponent(slug)}`;
}
