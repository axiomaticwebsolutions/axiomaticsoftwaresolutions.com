/**
 * Compare page model (pure, client-safe), ported from Compare.dc.html renderVals(). The server turns each published
 * product into a CompareProduct (plain JSON) and the client view builds the table rows from the selection.
 */
import { COMPARE_MAX } from "@/lib/compare/store";
import { latestRelease, platformsLabel, startingPlan, trialPlan, unitLabel } from "@/lib/storefront/derive";
import type { Platform, StoreProduct, Tone } from "@/lib/storefront/types";

export type CompareProduct = {
  id: string;
  name: string;
  shortName: string;
  icon: string;
  tone: Tone;
  categoryName: string;
  platforms: Platform[];
  /** Latest published version ("4.2.1"), or null before the first release. */
  latestVersion: string | null;
  /** Trial length in days, or null without a trial plan. */
  trialDays: number | null;
  oneTime: boolean;
  annual: boolean;
  subscription: boolean;
  /** A multi-device plan or a per-unit (per terminal) plan. */
  multiDevice: boolean;
  maintenance: boolean;
  /** Highest device count one license can cover: max over all plans of (maxQty || deviceLimit || 0). */
  maxDevices: number;
  /** Feature titles, in product order. */
  features: string[];
  demoEnabled: boolean;
  /** Starting price EXCLUDING GST (the compare page always shows excl. prices) and its unit. */
  startingPricePaise: number | null;
  startingUnit: string | null;
};

export function toCompareProduct(p: StoreProduct): CompareProduct {
  const start = startingPlan(p);
  const has = (type: StoreProduct["plans"][number]["type"]) => p.plans.some((plan) => plan.type === type);
  return {
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    icon: p.icon,
    tone: p.tone,
    categoryName: p.category.name,
    platforms: [...p.platforms],
    latestVersion: latestRelease(p)?.version ?? null,
    trialDays: trialPlan(p)?.trialDays ?? null,
    oneTime: has("ONE_TIME"),
    annual: has("ANNUAL"),
    subscription: has("SUBSCRIPTION"),
    multiDevice: p.plans.some((plan) => plan.multiDevice || Boolean(plan.perUnit)),
    maintenance: has("MAINTENANCE"),
    maxDevices: Math.max(0, ...p.plans.map((plan) => plan.maxQty || plan.deviceLimit || 0)),
    features: p.content.features.map((f) => f.title),
    demoEnabled: p.demoEnabled,
    startingPricePaise: start ? start.pricePaise : null,
    startingUnit: start ? unitLabel(start) : null,
  };
}

/** Selection slots: a product slug or "" for an empty slot (Remove leaves a gap until the next visit). */
export type CompareSlots = [string, string, string];

/** Up to three known ids, in order, padded with empty slots. */
export function toSlots(ids: readonly string[], known?: readonly { id: string }[]): CompareSlots {
  const valid = ids.filter((id, i) => id && ids.indexOf(id) === i && (!known || known.some((p) => p.id === id)));
  const slots: CompareSlots = ["", "", ""];
  valid.slice(0, COMPARE_MAX).forEach((id, i) => {
    slots[i] = id;
  });
  return slots;
}

/** The selected ids without gaps. */
export function slotIds(slots: readonly string[]): string[] {
  return slots.filter(Boolean);
}

/** Default columns when neither the URL nor the visitor chose any: the first two published products by rank. */
export function defaultCompareIds(products: readonly { id: string }[]): string[] {
  return products.slice(0, 2).map((p) => p.id);
}

/** A table cell: a check (included), a dash (not included) or text. */
export type CompareCell = { kind: "yes" } | { kind: "no" } | { kind: "text"; text: string };

export type CompareRow =
  | { kind: "group"; label: string }
  | { kind: "row"; label: string; cells: CompareCell[] };

const yes: CompareCell = { kind: "yes" };
const no: CompareCell = { kind: "no" };
const yn = (value: boolean): CompareCell => (value ? yes : no);
const text = (value: string): CompareCell => ({ kind: "text", text: value });

/** Table body rows, grouped Basics / Licensing / Features / Support, one cell per selected product. */
export function compareRows(products: readonly CompareProduct[]): CompareRow[] {
  const row = (label: string, cell: (p: CompareProduct) => CompareCell): CompareRow => ({
    kind: "row",
    label,
    cells: products.map(cell),
  });
  const features = [...new Set(products.flatMap((p) => p.features))];
  return [
    { kind: "group", label: "Basics" },
    row("Category", (p) => text(p.categoryName)),
    row("Operating systems", (p) => text(platformsLabel(p.platforms, ", "))),
    row("Latest version", (p) => (p.latestVersion ? text(`v${p.latestVersion}`) : no)),
    { kind: "group", label: "Licensing" },
    row("Free trial", (p) => (p.trialDays !== null ? text(`${p.trialDays} days`) : no)),
    row("One-time license", (p) => yn(p.oneTime)),
    row("Annual license", (p) => yn(p.annual)),
    row("Subscription", (p) => yn(p.subscription)),
    row("Multi-device option", (p) => yn(p.multiDevice)),
    row("Maintenance plan", (p) => yn(p.maintenance)),
    row("Most devices on one license", (p) => text(String(p.maxDevices))),
    { kind: "group", label: "Features" },
    ...features.map((f) => row(f, (p) => yn(p.features.includes(f)))),
    { kind: "group", label: "Support" },
    row("Standard support", () => yes),
    row("Demo on request", (p) => yn(p.demoEnabled)),
  ];
}

/** "A", "A and B", "A, B and C" (table caption). */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
