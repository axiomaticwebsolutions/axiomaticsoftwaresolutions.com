/**
 * Software catalog rules (pure, client-safe), ported from Software.dc.html renderVals():
 * - search: case-insensitive substring over name, tagline, summary, category name and feature titles;
 * - facets: OR within a group, AND across groups; each option's count = products matching every OTHER active filter
 *   plus that option (the group's own selection is skipped);
 * - price bands compare the starting price EXCLUDING GST, whatever the price display;
 * - sorts: featured (rank), starting price, name (A–Z), newest (latest published release); whatever the sort,
 *   products on sale come first and COMING_SOON products after them (decisions.md 2026-10-09);
 * - availability: all, available now (on sale) or coming soon.
 * The query lives in the URL (/software?q=&category=&availability=&price=&os=&license=&sort=, docs/decisions.md), so
 * the server page renders the same results the client computes.
 */
import {
  LICENSE_TYPE_KEYS,
  LICENSE_TYPE_LABELS,
  PLATFORMS,
  PLATFORM_LABELS,
  hasTrial,
  isLicenseTypeKey,
  isPlatform,
  latestRelease,
  licenseTypeKeys,
  startingPlan,
  unitLabel,
  type LicenseTypeKey,
} from "./derive";
import type { Platform, StoreProduct, Tone } from "./types";

export const CATALOG_PATH = "/software";

/** Longest search term kept from the URL. */
export const CATALOG_QUERY_MAX_LENGTH = 100;

// ---------- Price bands ----------

export type PriceBandKey = "any" | "under-3000" | "3000-7000" | "over-7000";

export const PRICE_BAND_KEYS: readonly PriceBandKey[] = ["any", "under-3000", "3000-7000", "over-7000"];

export const PRICE_BAND_LABELS: Readonly<Record<PriceBandKey, string>> = {
  any: "Any price",
  "under-3000": "Under ₹3,000",
  "3000-7000": "₹3,000 – ₹7,000",
  "over-7000": "Above ₹7,000",
};

const BAND_LOW = 300_000; // ₹3,000 in paise
const BAND_HIGH = 700_000; // ₹7,000 in paise

export function isPriceBandKey(value: string): value is PriceBandKey {
  return (PRICE_BAND_KEYS as readonly string[]).includes(value);
}

/**
 * Whether a starting price (paise, EXCLUDING GST) falls in a band: under ₹3,000 (< 300000), ₹3,000 – ₹7,000
 * (300000 to 700000, both ends included), above ₹7,000 (> 700000). A product without a paid plan only matches "any".
 */
export function inPriceBand(paise: number | null, band: PriceBandKey): boolean {
  if (band === "any") return true;
  if (paise === null) return false;
  if (band === "under-3000") return paise < BAND_LOW;
  if (band === "3000-7000") return paise >= BAND_LOW && paise <= BAND_HIGH;
  return paise > BAND_HIGH;
}

// ---------- Availability ----------

export type AvailabilityKey = "all" | "available" | "coming-soon";

export const AVAILABILITY_KEYS: readonly AvailabilityKey[] = ["all", "available", "coming-soon"];

export const AVAILABILITY_LABELS: Readonly<Record<AvailabilityKey, string>> = {
  all: "All",
  available: "Available now",
  "coming-soon": "Coming soon",
};

export function isAvailabilityKey(value: string): value is AvailabilityKey {
  return (AVAILABILITY_KEYS as readonly string[]).includes(value);
}

export function matchesAvailability(item: Pick<CatalogItem, "comingSoon">, availability: AvailabilityKey): boolean {
  if (availability === "all") return true;
  return availability === "coming-soon" ? item.comingSoon : !item.comingSoon;
}

/** The catalog filtered to coming-soon products (the header menu's "N coming soon" link). */
export const COMING_SOON_CATALOG_HREF = "/software?availability=coming-soon";

// ---------- Sorts ----------

export type CatalogSort = "featured" | "price-asc" | "price-desc" | "name" | "newest";

/** Sort select options, in prototype order. */
export const CATALOG_SORTS: readonly { value: CatalogSort; label: string }[] = [
  { value: "featured", label: "Featured" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "name", label: "Name: A–Z" },
  { value: "newest", label: "Newest first" },
];

export function isCatalogSort(value: string): value is CatalogSort {
  return CATALOG_SORTS.some((s) => s.value === value);
}

// ---------- Query ----------

export type CatalogQuery = {
  /** Search text as typed (trimmed when matching and in the URL). */
  q: string;
  /** Category slugs, in the order they were picked. */
  category: string[];
  availability: AvailabilityKey;
  price: PriceBandKey;
  os: Platform[];
  license: LicenseTypeKey[];
  sort: CatalogSort;
};

/** Filter groups in the sidebar. */
export type CatalogFacet = "category" | "availability" | "price" | "os" | "license";

export const DEFAULT_CATALOG_QUERY: Readonly<CatalogQuery> = Object.freeze({
  q: "",
  category: [],
  availability: "all",
  price: "any",
  os: [],
  license: [],
  sort: "featured",
});

/** URLSearchParams, or the object Next passes to a page as `searchParams`. */
export type CatalogParamSource = URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

function rawValues(src: CatalogParamSource, key: string): string[] {
  if (src instanceof URLSearchParams) return src.getAll(key);
  const value = src[key];
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

/** Every value of a list parameter: repeated (?os=windows&os=macos) and comma-separated (?os=windows,macos). */
function listValues(src: CatalogParamSource, key: string): string[] {
  const out: string[] = [];
  for (const raw of rawValues(src, key)) {
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ParseCatalogOptions = {
  /** Known category slugs; unknown ones are dropped. Without it, any slug-shaped value is kept. */
  categoryIds?: readonly string[];
};

/** Reads the catalog query from URL parameters. Unknown or malformed values fall back to the defaults. */
export function parseCatalogParams(src: CatalogParamSource, opts: ParseCatalogOptions = {}): CatalogQuery {
  const q = (rawValues(src, "q")[0] ?? "").slice(0, CATALOG_QUERY_MAX_LENGTH);
  const known = opts.categoryIds;
  const category = listValues(src, "category").filter((c) => (known ? known.includes(c) : SLUG.test(c)));
  const availability = rawValues(src, "availability")[0]?.trim() ?? "";
  const price = rawValues(src, "price")[0]?.trim() ?? "";
  const sort = rawValues(src, "sort")[0]?.trim() ?? "";
  return {
    q,
    category,
    availability: isAvailabilityKey(availability) ? availability : "all",
    price: isPriceBandKey(price) ? price : "any",
    os: listValues(src, "os").filter(isPlatform),
    license: listValues(src, "license").filter(isLicenseTypeKey),
    sort: isCatalogSort(sort) ? sort : "featured",
  };
}

function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/**
 * The query string for a catalog query ("" when everything is default), e.g.
 * "?q=gst+billing&category=pharmacy,retail&availability=available&price=3000-7000&os=windows&license=trial&sort=price-asc".
 */
export function catalogSearch(query: CatalogQuery): string {
  const parts: string[] = [];
  const q = query.q.trim();
  if (q) parts.push(`q=${encodeValue(q)}`);
  if (query.category.length) parts.push(`category=${query.category.map(encodeValue).join(",")}`);
  if (query.availability !== "all") parts.push(`availability=${query.availability}`);
  if (query.price !== "any") parts.push(`price=${query.price}`);
  if (query.os.length) parts.push(`os=${query.os.join(",")}`);
  if (query.license.length) parts.push(`license=${query.license.join(",")}`);
  if (query.sort !== "featured") parts.push(`sort=${query.sort}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** "/software" plus the query string; equal hrefs mean equivalent queries. */
export function catalogHref(query: CatalogQuery): string {
  return `${CATALOG_PATH}${catalogSearch(query)}`;
}

// ---------- Items ----------

/** The catalog's view of a product: plain JSON, computed on the server and handed to the client view. */
export type CatalogItem = {
  id: string;
  name: string;
  shortName: string;
  tagline: string;
  icon: string;
  tone: Tone;
  categoryId: string;
  categoryName: string;
  /** COMING_SOON: a "Coming soon" badge instead of a price, no Compare (never sold). */
  comingSoon: boolean;
  platforms: Platform[];
  licenseTypes: LicenseTypeKey[];
  hasTrial: boolean;
  /** Cheapest paid main plan, EXCLUDING GST; null when the product has no paid plan. */
  startingPricePaise: number | null;
  /** "/year", "/month", "one-time"... for the starting plan. */
  startingUnit: string | null;
  rank: number;
  /** Latest published release (ISO), for "Newest first". */
  latestReleaseAt: string | null;
  /** Lower-cased name, tagline, summary, category name and feature titles, joined with spaces. */
  searchText: string;
};

export function toCatalogItem(p: StoreProduct): CatalogItem {
  const start = startingPlan(p);
  return {
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    tagline: p.tagline,
    icon: p.icon,
    tone: p.tone,
    categoryId: p.category.id,
    categoryName: p.category.name,
    comingSoon: p.comingSoon,
    platforms: [...p.platforms],
    licenseTypes: licenseTypeKeys(p),
    hasTrial: hasTrial(p),
    startingPricePaise: start ? start.pricePaise : null,
    startingUnit: start ? unitLabel(start) : null,
    rank: p.rank,
    latestReleaseAt: latestRelease(p)?.releasedAt ?? null,
    searchText: [p.name, p.tagline, p.summary, p.category.name, ...p.content.features.map((f) => f.title)]
      .join(" ")
      .toLowerCase(),
  };
}

/** Search text as matched: trimmed and lower-cased. */
export function normalizeSearch(q: string): string {
  return q.trim().toLowerCase();
}

/** Whether an item passes the query, optionally ignoring one filter group (for that group's option counts). */
export function matchesCatalogQuery(item: CatalogItem, query: CatalogQuery, skip?: CatalogFacet): boolean {
  const q = normalizeSearch(query.q);
  if (q && !item.searchText.includes(q)) return false;
  if (skip !== "category" && query.category.length && !query.category.includes(item.categoryId)) return false;
  if (skip !== "availability" && !matchesAvailability(item, query.availability)) return false;
  if (skip !== "os" && query.os.length && !query.os.some((os) => item.platforms.includes(os))) return false;
  if (skip !== "license" && query.license.length && !query.license.some((l) => item.licenseTypes.includes(l))) {
    return false;
  }
  if (skip !== "price" && !inPriceBand(item.startingPricePaise, query.price)) return false;
  return true;
}

const nameCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function byPrice(a: CatalogItem, b: CatalogItem, direction: 1 | -1): number {
  // Products without a paid plan go last in both directions.
  if (a.startingPricePaise === null || b.startingPricePaise === null) {
    return (a.startingPricePaise === null ? 1 : 0) - (b.startingPricePaise === null ? 1 : 0);
  }
  return (a.startingPricePaise - b.startingPricePaise) * direction;
}

function byNewest(a: CatalogItem, b: CatalogItem): number {
  if (a.latestReleaseAt === b.latestReleaseAt) return 0;
  if (a.latestReleaseAt === null) return 1;
  if (b.latestReleaseAt === null) return -1;
  return b.latestReleaseAt.localeCompare(a.latestReleaseAt);
}

const COMPARATORS: Readonly<Record<CatalogSort, (a: CatalogItem, b: CatalogItem) => number>> = {
  featured: (a, b) => a.rank - b.rank,
  "price-asc": (a, b) => byPrice(a, b, 1),
  "price-desc": (a, b) => byPrice(a, b, -1),
  name: (a, b) => nameCollator.compare(a.name, b.name),
  newest: byNewest,
};

/**
 * A sorted copy: products on sale first, then coming-soon products, each group in the chosen order (stable: ties keep
 * the input order, which is rank order from the data layer).
 */
export function sortCatalog(items: readonly CatalogItem[], sort: CatalogSort): CatalogItem[] {
  const compare = COMPARATORS[sort];
  return [...items].sort((a, b) => Number(a.comingSoon) - Number(b.comingSoon) || compare(a, b));
}

/** The results for a query: matching items, sorted. */
export function filterCatalog(items: readonly CatalogItem[], query: CatalogQuery): CatalogItem[] {
  return sortCatalog(
    items.filter((item) => matchesCatalogQuery(item, query)),
    query.sort,
  );
}

// ---------- Facets ----------

export type CatalogCategoryOption = { id: string; name: string };

export type FacetOption<V extends string> = {
  value: V;
  label: string;
  checked: boolean;
  /** Live count; null for "Any price", which shows none. */
  count: number | null;
};

export type CatalogFacets = {
  category: FacetOption<string>[];
  availability: FacetOption<AvailabilityKey>[];
  price: FacetOption<PriceBandKey>[];
  os: FacetOption<Platform>[];
  license: FacetOption<LicenseTypeKey>[];
};

/** Sidebar options with their live counts. */
export function catalogFacets(
  items: readonly CatalogItem[],
  query: CatalogQuery,
  categories: readonly CatalogCategoryOption[],
): CatalogFacets {
  const count = (skip: CatalogFacet, test: (item: CatalogItem) => boolean) =>
    items.filter((item) => matchesCatalogQuery(item, query, skip) && test(item)).length;
  return {
    category: categories.map((c) => ({
      value: c.id,
      label: c.name,
      checked: query.category.includes(c.id),
      count: count("category", (item) => item.categoryId === c.id),
    })),
    availability: AVAILABILITY_KEYS.map((key) => ({
      value: key,
      label: AVAILABILITY_LABELS[key],
      checked: query.availability === key,
      count: key === "all" ? null : count("availability", (item) => matchesAvailability(item, key)),
    })),
    price: PRICE_BAND_KEYS.map((band) => ({
      value: band,
      label: PRICE_BAND_LABELS[band],
      checked: query.price === band,
      count: band === "any" ? null : count("price", (item) => inPriceBand(item.startingPricePaise, band)),
    })),
    os: PLATFORMS.map((os) => ({
      value: os,
      label: PLATFORM_LABELS[os],
      checked: query.os.includes(os),
      count: count("os", (item) => item.platforms.includes(os)),
    })),
    license: LICENSE_TYPE_KEYS.map((key) => ({
      value: key,
      label: LICENSE_TYPE_LABELS[key],
      checked: query.license.includes(key),
      count: count("license", (item) => item.licenseTypes.includes(key)),
    })),
  };
}

// ---------- Query updates ----------

export type CatalogListFacet = "category" | "os" | "license";

function toggled<T extends string>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Adds or removes one value of a multi-select group (invalid values leave the query unchanged). */
export function toggleFacetValue(query: CatalogQuery, facet: CatalogListFacet, value: string): CatalogQuery {
  if (facet === "category") return SLUG.test(value) ? { ...query, category: toggled(query.category, value) } : query;
  if (facet === "os") return isPlatform(value) ? { ...query, os: toggled(query.os, value) } : query;
  return isLicenseTypeKey(value) ? { ...query, license: toggled(query.license, value) } : query;
}

/** "Clear all filters" / "Clear search and filters": search and every filter group; the sort stays. */
export function clearCatalogFilters(query: CatalogQuery): CatalogQuery {
  return { q: "", category: [], availability: "all", price: "any", os: [], license: [], sort: query.sort };
}

/** Number of active filters (the "Filters (n)" button); the search text is not counted. */
export function activeFilterCount(query: CatalogQuery): number {
  return (
    query.category.length +
    query.os.length +
    query.license.length +
    (query.price !== "any" ? 1 : 0) +
    (query.availability !== "all" ? 1 : 0)
  );
}

export type CatalogChip = {
  /** Stable React key, e.g. "os:windows". */
  key: string;
  facet: "q" | CatalogFacet;
  value: string;
  /** Visible text: “billing”, "Medical & Pharmacy", "Under ₹3,000"... */
  label: string;
};

/** Removable chips: search term, categories, availability, price band, operating systems, license types. */
export function catalogChips(query: CatalogQuery, categories: readonly CatalogCategoryOption[]): CatalogChip[] {
  const chips: CatalogChip[] = [];
  const q = query.q.trim();
  if (q) chips.push({ key: "q", facet: "q", value: q, label: `“${q}”` });
  for (const id of query.category) {
    const label = categories.find((c) => c.id === id)?.name ?? id;
    chips.push({ key: `category:${id}`, facet: "category", value: id, label });
  }
  if (query.availability !== "all") {
    chips.push({ key: "availability", facet: "availability", value: query.availability, label: AVAILABILITY_LABELS[query.availability] });
  }
  if (query.price !== "any") {
    chips.push({ key: "price", facet: "price", value: query.price, label: PRICE_BAND_LABELS[query.price] });
  }
  for (const os of query.os) chips.push({ key: `os:${os}`, facet: "os", value: os, label: PLATFORM_LABELS[os] });
  for (const key of query.license) {
    chips.push({ key: `license:${key}`, facet: "license", value: key, label: LICENSE_TYPE_LABELS[key] });
  }
  return chips;
}

/** The query without one chip's filter. */
export function removeCatalogChip(query: CatalogQuery, chip: Pick<CatalogChip, "facet" | "value">): CatalogQuery {
  switch (chip.facet) {
    case "q":
      return { ...query, q: "" };
    case "price":
      return { ...query, price: "any" };
    case "availability":
      return { ...query, availability: "all" };
    case "category":
      return { ...query, category: query.category.filter((v) => v !== chip.value) };
    case "os":
      return { ...query, os: query.os.filter((v) => v !== chip.value) };
    case "license":
      return { ...query, license: query.license.filter((v) => v !== chip.value) };
  }
}

// ---------- Copy ----------

/** "1 product" / "4 products". */
export function resultCountLabel(count: number): string {
  return `${count} ${count === 1 ? "product" : "products"}`;
}

/** Empty state subject: “q”, “q” with these filters, or these filters ("No software matches …"). */
export function emptyStateSubject(query: CatalogQuery): string {
  const q = query.q.trim();
  if (!q) return "these filters";
  return activeFilterCount(query) > 0 ? `“${q}” with these filters` : `“${q}”`;
}

/** The compare limit toast (Software.dc.html). */
export const COMPARE_LIMIT_MESSAGE = "You can compare up to three products. Remove one to add another.";
