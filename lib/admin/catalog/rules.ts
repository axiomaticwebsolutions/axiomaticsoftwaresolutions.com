/**
 * Pure catalog rules shared by the admin services and tests: which release is a product's "latest", what publishing a
 * product still needs, and the audit wording of product and plan edits (prices audited old -> new). No server imports.
 */
import { compareVersions } from "@/lib/licensing/entitlement";
import { formatINR } from "@/lib/money";
import { PLAN_TYPE_LABELS } from "./model";
import type { BillingIntervalKey, PlanTypeKey } from "./types";

/** Customers only ever see this channel (decisions.md Phase 4), so "latest" is computed on it. */
export const CUSTOMER_CHANNEL = "stable";

export type ReleaseForLatest = { id: string; productId: string; version: string; releasedAt: Date | null; channel: string; status: string };

/**
 * Id of each product's latest release: the highest version among its PUBLISHED stable releases (semver precedence;
 * the release date only breaks ties), the same rule as the portal and /validate.
 */
export function latestReleaseIds(releases: readonly ReleaseForLatest[]): Map<string, string> {
  const best = new Map<string, ReleaseForLatest>();
  for (const r of releases) {
    if (r.status !== "PUBLISHED" || r.channel !== CUSTOMER_CHANNEL || !r.releasedAt) continue;
    const current = best.get(r.productId);
    if (!current) {
      best.set(r.productId, r);
      continue;
    }
    const byVersion = compareVersions(r.version, current.version);
    const newer = byVersion > 0 || (byVersion === 0 && (r.releasedAt?.getTime() ?? 0) > (current.releasedAt?.getTime() ?? 0));
    if (newer) best.set(r.productId, r);
  }
  return new Map([...best].map(([productId, r]) => [productId, r.id]));
}

export const PUBLISH_BLOCKERS = {
  content: "Add at least one feature to the product page content.",
  plan: "Put at least one plan on sale (not an add-on or maintenance plan).",
  release: "Publish a stable release with an installer.",
} as const;

/** What a product still needs before it can be published ([] when it can be). */
export function productPublishBlockers(input: { contentValid: boolean; mainPlansOnSale: number; publishedStableReleases: number }): string[] {
  const out: string[] = [];
  if (!input.contentValid) out.push(PUBLISH_BLOCKERS.content);
  if (input.mainPlansOnSale < 1) out.push(PUBLISH_BLOCKERS.plan);
  if (input.publishedStableReleases < 1) out.push(PUBLISH_BLOCKERS.release);
  return out;
}

/** Plan types sold on their own (storefront main plans); add-ons and maintenance change an existing license. */
export function isMainPlanType(type: PlanTypeKey): boolean {
  return type !== "DEVICE_ADDON" && type !== "MAINTENANCE";
}

// ---------- Audit wording ----------

const PRODUCT_FIELD_LABELS = {
  code: "License prefix",
  name: "Product name",
  shortName: "Display name",
  tagline: "Tagline",
  summary: "Summary",
  categoryId: "Category",
  platforms: "Platforms",
  icon: "Icon",
  tone: "Colour",
  rank: "Rank",
  demoEnabled: "Demo requests",
  content: "Page content",
  relatedIds: "Related products",
} as const;

export type ProductFieldKey = keyof typeof PRODUCT_FIELD_LABELS;

/** JSON with object keys sorted (jsonb columns come back with their keys reordered). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/** Keys of `patch` whose value differs from `before` (undefined = not sent). */
export function changedKeys<K extends string>(before: Readonly<Record<K, unknown>>, patch: Partial<Record<K, unknown>>): K[] {
  return (Object.keys(patch) as K[]).filter((k) => patch[k] !== undefined && !sameValue(before[k], patch[k]));
}

/** "License prefix MED → MDX · Tagline, Page content" (code changes spelled out, other fields named). */
export function productChangeSummary(
  before: { code: string } & Record<ProductFieldKey, unknown>,
  changed: readonly ProductFieldKey[],
  after: { code?: string },
): string {
  const parts: string[] = [];
  if (changed.includes("code") && after.code) parts.push(`License prefix ${before.code} \u2192 ${after.code}`);
  const others = changed.filter((k) => k !== "code").map((k) => PRODUCT_FIELD_LABELS[k]);
  if (others.length > 0) parts.push(others.join(", "));
  return parts.join(" \u00B7 ");
}

export type PlanEditable = {
  name: string;
  summary: string | null;
  includes: string[];
  pricePaise: number;
  interval: BillingIntervalKey | null;
  trialDays: number | null;
  deviceLimit: number | null;
  perUnit: string | null;
  maxQty: number | null;
  multiDevice: boolean;
  updatesMonths: number | null;
  popular: boolean;
  sortOrder: number;
};

const PLAN_FIELD_LABELS: Record<keyof PlanEditable, string> = {
  name: "Name",
  summary: "Summary",
  includes: "Includes",
  pricePaise: "Price",
  interval: "Billing period",
  trialDays: "Trial days",
  deviceLimit: "Device limit",
  perUnit: "Per unit",
  maxQty: "Max quantity",
  multiDevice: "Multi-device",
  updatesMonths: "Updates",
  popular: "Popular",
  sortOrder: "Sort order",
};

const INTERVAL_WORDS: Record<BillingIntervalKey, string> = { MONTH: "monthly", YEAR: "yearly" };

function planValue(key: keyof PlanEditable, value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (key === "pricePaise" && typeof value === "number") return value > 0 ? formatINR(value) : "Free";
  if (key === "interval") return INTERVAL_WORDS[value as BillingIntervalKey] ?? String(value);
  if (typeof value === "boolean") return value ? "on" : "off";
  if (key === "updatesMonths" || key === "trialDays") return `${String(value)} ${key === "trialDays" ? "days" : "months"}`;
  return String(value);
}

const SPELLED_OUT: ReadonlySet<keyof PlanEditable> = new Set([
  "pricePaise",
  "interval",
  "trialDays",
  "deviceLimit",
  "perUnit",
  "maxQty",
  "multiDevice",
  "updatesMonths",
  "popular",
  "sortOrder",
]);

/**
 * Audit of a plan edit: the action ("Changed plan price" when the price moved, else "Updated plan") and the detail,
 * with the price first as the prototype logs it ("₹4,999 → ₹5,499"), then other value changes old → new and the text
 * fields by name ("Device limit 1 → 2 · Summary, Includes").
 */
export function planChangeAudit(before: PlanEditable, changed: readonly (keyof PlanEditable)[], after: PlanEditable): { action: string; detail: string } {
  const parts: string[] = [];
  if (changed.includes("pricePaise")) parts.push(`${planValue("pricePaise", before.pricePaise)} \u2192 ${planValue("pricePaise", after.pricePaise)}`);
  for (const key of changed) {
    if (key === "pricePaise" || !SPELLED_OUT.has(key)) continue;
    parts.push(`${PLAN_FIELD_LABELS[key]} ${planValue(key, before[key])} \u2192 ${planValue(key, after[key])}`);
  }
  const named = changed.filter((k) => !SPELLED_OUT.has(k)).map((k) => PLAN_FIELD_LABELS[k]);
  if (named.length > 0) parts.push(named.join(", "));
  return { action: changed.includes("pricePaise") ? "Changed plan price" : "Updated plan", detail: parts.join(" \u00B7 ") };
}

/** "Medical Billing · Annual license" (audit target of a plan). */
export function planAuditTarget(productShortName: string, planName: string): string {
  return `${productShortName} \u00B7 ${planName}`;
}

/** "Medical Billing v4.2.1" (audit target and list title of a release). */
export function releaseTitle(productShortName: string, version: string): string {
  return `${productShortName} v${version}`;
}

export function planTypeLabel(type: PlanTypeKey): string {
  return PLAN_TYPE_LABELS[type];
}
