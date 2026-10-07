/**
 * Pure storefront rules ported from the prototype data module (axiomatic-data.js) and page logic.
 * Client-safe: no server imports, no runtime enum import (plan types are compared as string literals).
 */
import type { IconName } from "@/components/icons/registry";
import type { Platform, PlanType, StoreLatestRelease, StorePlan, StoreProduct, StoreRelease } from "./types";

type WithPlans = Pick<StoreProduct, "plans">;
type WithReleases = Pick<StoreProduct, "releases">;

const ADD_ON_TYPES: ReadonlySet<PlanType> = new Set<PlanType>(["DEVICE_ADDON", "MAINTENANCE"]);

/** Plans sold on their own: every plan except device add-ons and maintenance (trials included). */
export function mainPlans(p: WithPlans): StorePlan[] {
  return p.plans.filter((plan) => !ADD_ON_TYPES.has(plan.type));
}

/** Device add-ons and maintenance: they change an existing license ("Add-ons for existing licenses"). */
export function addOnPlans(p: WithPlans): StorePlan[] {
  return p.plans.filter((plan) => ADD_ON_TYPES.has(plan.type));
}

export function trialPlan(p: WithPlans): StorePlan | null {
  return p.plans.find((plan) => plan.type === "TRIAL") ?? null;
}

export function hasTrial(p: WithPlans): boolean {
  return trialPlan(p) !== null;
}

/** The "From" price: the cheapest paid main plan (the first one in sortOrder on a tie), or null when none is paid. */
export function startingPlan(p: WithPlans): StorePlan | null {
  let best: StorePlan | null = null;
  for (const plan of mainPlans(p)) {
    if (plan.pricePaise > 0 && (best === null || plan.pricePaise < best.pricePaise)) best = plan;
  }
  return best;
}

export type LicenseTypeKey = "trial" | "one_time" | "annual" | "subscription" | "multi";

/** Catalog filter order (prototype LICENSE_TYPES). */
export const LICENSE_TYPE_KEYS: readonly LicenseTypeKey[] = ["trial", "one_time", "annual", "subscription", "multi"];

export const LICENSE_TYPE_LABELS: Readonly<Record<LicenseTypeKey, string>> = {
  trial: "Free trial",
  one_time: "One-time",
  annual: "Annual",
  subscription: "Subscription",
  multi: "Multi-device",
};

const LICENSE_TYPE_OF: Partial<Record<PlanType, LicenseTypeKey>> = {
  TRIAL: "trial",
  ONE_TIME: "one_time",
  ANNUAL: "annual",
  SUBSCRIPTION: "subscription",
};

export function isLicenseTypeKey(value: string): value is LicenseTypeKey {
  return (LICENSE_TYPE_KEYS as readonly string[]).includes(value);
}

/**
 * License types a product offers, in plan order (prototype licenseTypes()): the plan types that are license types,
 * plus "multi" when any plan is multi-device or priced per unit.
 */
export function licenseTypeKeys(p: WithPlans): LicenseTypeKey[] {
  const keys = new Set<LicenseTypeKey>();
  for (const plan of p.plans) {
    const key = LICENSE_TYPE_OF[plan.type];
    if (key) keys.add(key);
    if (plan.multiDevice || plan.perUnit) keys.add("multi");
  }
  return [...keys];
}

const PLAN_TYPE_TAGS: Readonly<Record<PlanType, string>> = {
  TRIAL: "FREE TRIAL",
  ONE_TIME: "ONE-TIME",
  ANNUAL: "ANNUAL",
  SUBSCRIPTION: "SUBSCRIPTION",
  DEVICE_ADDON: "ADD-ON",
  MAINTENANCE: "MAINTENANCE",
};

/** Plan card overline: "MULTI-DEVICE" for multi-device plans, otherwise the plan type ("ONE-TIME", "FREE TRIAL"...). */
export function planTypeTag(plan: Pick<StorePlan, "type" | "multiDevice">): string {
  return plan.multiDevice ? "MULTI-DEVICE" : PLAN_TYPE_TAGS[plan.type];
}

type UnitPlan = Pick<StorePlan, "type" | "interval" | "trialDays" | "perUnit">;

function pluralUnit(unit: string): string {
  return unit.endsWith("s") ? unit : `${unit}s`;
}

/**
 * Price unit text (prototype unitLabel): "15 days" for trials, "/year", "/month", otherwise "one-time".
 * With `qty`, per-unit plans add the unit: "/month per terminal" (qty 1) or "/month for 3 terminals" (qty > 1).
 */
export function unitLabel(plan: UnitPlan, qty?: number): string {
  const base =
    plan.type === "TRIAL"
      ? `${plan.trialDays ?? 0} days`
      : plan.interval === "YEAR"
        ? "/year"
        : plan.interval === "MONTH"
          ? "/month"
          : "one-time";
  if (qty === undefined || plan.type === "TRIAL" || !plan.perUnit) return base;
  return qty > 1 ? `${base} for ${qty} ${pluralUnit(plan.perUnit)}` : `${base} per ${plan.perUnit}`;
}

/** Plan card unit text: "for 15 days" for trials, otherwise unitLabel(plan, qty). */
export function planUnitLabel(plan: UnitPlan, qty = 1): string {
  return plan.type === "TRIAL" ? `for ${plan.trialDays ?? 0} days` : unitLabel(plan, qty);
}

/** Highest quantity the product page stepper and cart allow: per-unit plans up to maxQty (default 10), others 1. */
export function maxQtyFor(plan: Pick<StorePlan, "perUnit" | "maxQty">): number {
  return plan.perUnit ? (plan.maxQty ?? 10) : 1;
}

export function latestRelease(p: WithReleases): StoreRelease | null {
  return p.releases[0] ?? null;
}

/** "5.0.2" -> "5.0" (hero announcement: "General Store GST Billing 5.0 is out"). */
export function majorMinor(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

export const PLATFORMS: readonly Platform[] = ["windows", "macos", "android"];

export const PLATFORM_LABELS: Readonly<Record<Platform, string>> = { windows: "Windows", macos: "macOS", android: "Android" };

export const PLATFORM_ICONS: Readonly<Record<Platform, IconName>> = {
  windows: "desktop_windows",
  macos: "laptop_mac",
  android: "phone_android",
};

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** "Windows · macOS" (cards, hero); pass ", " for tables. */
export function platformsLabel(platforms: readonly Platform[], separator = " · "): string {
  return platforms.map((p) => PLATFORM_LABELS[p]).join(separator);
}

const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;

/** Binary sizes the way the release notes show them: "148 MB", "512 KB", "1.2 GB". */
export function formatFileSize(bytes: number | bigint): string {
  const n = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= GIB) return `${(n / GIB).toFixed(1).replace(/\.0$/, "")} GB`;
  if (n >= MIB) return `${Math.round(n / MIB)} MB`;
  return `${n === 0 ? 0 : Math.max(1, Math.round(n / KIB))} KB`;
}

// ---------- Links (docs/decisions.md > Phase 2 storefront decisions) ----------

export function productHref(slug: string): string {
  return `/software/${encodeURIComponent(slug)}`;
}

export function categoryHref(categoryId: string): string {
  return `/software?category=${encodeURIComponent(categoryId)}`;
}

/** Contact page demo form, optionally preselecting the product. */
export function demoHref(slug?: string): string {
  return slug ? `/contact?type=demo&product=${encodeURIComponent(slug)}` : "/contact?type=demo";
}

/** Free trial: register (or sign in), then start the trial from Software & downloads (completed in Phase 3). */
export function trialHref(slug: string): string {
  return `/register?next=/account/software&trial=${encodeURIComponent(slug)}`;
}

/** Compare page for up to 3 product slugs. */
export function compareHref(ids: readonly string[]): string {
  return ids.length > 0 ? `/compare?ids=${ids.map(encodeURIComponent).join(",")}` : "/compare";
}

/** The newest PUBLISHED release across products (hero announcement), or null when nothing is released. */
export function newestRelease(
  products: readonly Pick<StoreProduct, "id" | "name" | "shortName" | "releases">[],
): StoreLatestRelease | null {
  let best: StoreLatestRelease | null = null;
  for (const p of products) {
    const release = p.releases[0];
    if (release && (best === null || release.releasedAt > best.release.releasedAt)) {
      best = { product: { id: p.id, name: p.name, shortName: p.shortName }, release };
    }
  }
  return best;
}
