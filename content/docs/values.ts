/**
 * Values for the `{token}` placeholders in the docs guides, and guides with the tokens filled in.
 * Numbers come from settings and env (the same sources the licensing code enforces), so the copy never drifts from
 * the rules: download link lifetime (settings + DOWNLOAD_LINK_TTL_SECONDS), self-service deactivations
 * (settings licensing.selfServiceResetsPerYear), offline grace (LICENSE_OFFLINE_GRACE_DAYS) and updates included with
 * one-time plans (Plan.updatesMonths). File-name and key examples follow the newest published releases.
 * Pure: the page reads settings and env and passes plain numbers in.
 */
import { DEFAULT_UPDATES_MONTHS } from "@/lib/licensing/terms";
import type { StoreProduct } from "@/lib/storefront/types";
import { DOC_GUIDES, DOC_PLATFORMS, guideHref, type DocGroup, type DocGuide, type DocPlatform, type DocStep } from "./guides";
import { fillTemplate, plural } from "./template";

export const DOC_TOKENS = [
  "downloadLinkTime",
  "selfServiceResets",
  "offlineGrace",
  "updatesPeriod",
  "windowsInstaller",
  "macInstaller",
  "licenseKeyExample",
] as const;
export type DocToken = (typeof DOC_TOKENS)[number];
export type DocsValues = Readonly<Record<DocToken, string>>;

/** The prototype's values; used for anything the inputs cannot provide (e.g. no Windows release yet). */
export const DOCS_VALUE_DEFAULTS: DocsValues = Object.freeze({
  downloadLinkTime: "10 minutes",
  selfServiceResets: "3 self-service deactivations",
  offlineGrace: "7 days",
  updatesPeriod: "12 months",
  windowsInstaller: "Axiomatic-MED-4.2.1-x64.exe",
  macInstaller: "Axiomatic-GST-5.0.2.dmg",
  licenseKeyExample: "MED-XXXX-XXXX-XXXX-XXXX",
});

export type DocsProduct = Pick<StoreProduct, "code" | "plans" | "releases">;

export type DocsValuesInput = {
  /** Effective presigned download TTL in seconds: downloadTtlSeconds(settings) from lib/config. */
  downloadTtlSeconds: number;
  /** settings.licensing.selfServiceResetsPerYear */
  selfServiceResetsPerYear: number;
  /** env LICENSE_OFFLINE_GRACE_DAYS */
  offlineGraceDays: number;
  /** Published products by rank. */
  products: readonly DocsProduct[];
};

const INSTALLER_SUFFIX: Readonly<Record<DocPlatform, string>> = { windows: "-x64.exe", macos: ".dmg" };

/** "Axiomatic-MED-4.2.1-x64.exe": the first product (by rank) whose newest release ships for the platform. */
function installerExample(products: readonly DocsProduct[], platform: DocPlatform): string | null {
  for (const product of products) {
    const release = product.releases[0];
    if (release?.platforms.includes(platform)) return `Axiomatic-${product.code}-${release.version}${INSTALLER_SUFFIX[platform]}`;
  }
  return null;
}

/** "12 months" when every one-time plan agrees, "12 to 24 months, depending on the plan" otherwise. */
function updatesPeriod(products: readonly DocsProduct[]): string {
  const months = new Set<number>();
  for (const product of products) {
    for (const plan of product.plans) {
      if (plan.type === "ONE_TIME") months.add(plan.updatesMonths ?? DEFAULT_UPDATES_MONTHS);
    }
  }
  const sorted = [...months].sort((a, b) => a - b);
  const low = sorted[0] ?? DEFAULT_UPDATES_MONTHS;
  const high = sorted[sorted.length - 1] ?? DEFAULT_UPDATES_MONTHS;
  return low === high ? plural(low, "month") : `${low} to ${high} months, depending on the plan`;
}

export function docsValues(input: DocsValuesInput): DocsValues {
  // Rounded down, so the copy never promises longer than the link lives.
  const minutes = Math.max(1, Math.floor(input.downloadTtlSeconds / 60));
  const firstCode = input.products[0]?.code;
  return {
    downloadLinkTime: plural(minutes, "minute"),
    selfServiceResets: plural(input.selfServiceResetsPerYear, "self-service deactivation"),
    offlineGrace: plural(input.offlineGraceDays, "day"),
    updatesPeriod: updatesPeriod(input.products),
    windowsInstaller: installerExample(input.products, "windows") ?? DOCS_VALUE_DEFAULTS.windowsInstaller,
    macInstaller: installerExample(input.products, "macos") ?? DOCS_VALUE_DEFAULTS.macInstaller,
    licenseKeyExample: firstCode ? `${firstCode}-XXXX-XXXX-XXXX-XXXX` : DOCS_VALUE_DEFAULTS.licenseKeyExample,
  };
}

export type ResolvedStep = { title: string; body: string; code: string | null };

/** A guide with every token filled: plain strings, safe to pass to client components. */
export type ResolvedGuide = {
  slug: string;
  href: string;
  group: DocGroup;
  title: string;
  summary: string;
  /** Steps of a single-list guide, else null. */
  steps: ResolvedStep[] | null;
  /** Steps per operating system (the OS tabs), else null. */
  platformSteps: Record<DocPlatform, ResolvedStep[]> | null;
  note: string | null;
};

function resolveSteps(steps: readonly DocStep[], values: DocsValues): ResolvedStep[] {
  return steps.map((step) => ({
    title: fillTemplate(step.title, values),
    body: fillTemplate(step.body, values),
    code: step.code ? fillTemplate(step.code, values) : null,
  }));
}

export function resolveGuide(guide: DocGuide, values: DocsValues): ResolvedGuide {
  const platformSteps = guide.platformSteps;
  return {
    slug: guide.slug,
    href: guideHref(guide.slug),
    group: guide.group,
    title: fillTemplate(guide.title, values),
    summary: fillTemplate(guide.summary, values),
    steps: guide.steps ? resolveSteps(guide.steps, values) : null,
    platformSteps: platformSteps
      ? (Object.fromEntries(DOC_PLATFORMS.map((p) => [p, resolveSteps(platformSteps[p], values)])) as Record<
          DocPlatform,
          ResolvedStep[]
        >)
      : null,
    note: guide.note ? fillTemplate(guide.note, values) : null,
  };
}

export function resolveGuides(values: DocsValues): ResolvedGuide[] {
  return DOC_GUIDES.map((guide) => resolveGuide(guide, values));
}
