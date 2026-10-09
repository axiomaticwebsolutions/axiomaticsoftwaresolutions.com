import { describe, expect, it } from "vitest";
import {
  compareRows,
  defaultCompareIds,
  joinNames,
  slotIds,
  toCompareProduct,
  toSlots,
  type CompareRow,
} from "@/components/store/compare/compare-model";
import {
  CATALOG_SORTS,
  COMPARE_LIMIT_MESSAGE,
  DEFAULT_CATALOG_QUERY,
  PRICE_BAND_LABELS,
  activeFilterCount,
  catalogChips,
  catalogFacets,
  catalogHref,
  catalogSearch,
  clearCatalogFilters,
  emptyStateSubject,
  filterCatalog,
  inPriceBand,
  matchesCatalogQuery,
  parseCatalogParams,
  removeCatalogChip,
  resultCountLabel,
  sortCatalog,
  toCatalogItem,
  toggleFacetValue,
  type CatalogItem,
  type CatalogQuery,
} from "@/lib/storefront/catalog-filter";
import { fixtureCategories, fixtureProducts } from "@/lib/storefront/fixtures";

const products = fixtureProducts();
const items = products.map(toCatalogItem);
const categories = fixtureCategories().map((c) => ({ id: c.id, name: c.name }));
const categoryIds = categories.map((c) => c.id);

const query = (patch: Partial<CatalogQuery> = {}): CatalogQuery => ({
  ...DEFAULT_CATALOG_QUERY,
  category: [],
  os: [],
  license: [],
  ...patch,
});
const ids = (list: readonly CatalogItem[]) => list.map((i) => i.id);
const counts = <T extends { value: string; count: number | null }>(options: readonly T[]) =>
  Object.fromEntries(options.map((o) => [o.value, o.count]));

describe("catalog items", () => {
  it("derive the card data the prototype shows", () => {
    expect(items.map((i) => [i.id, i.startingPricePaise, i.startingUnit])).toEqual([
      ["medical-billing", 499900, "/year"],
      ["restaurant-billing", 69900, "/month"],
      ["general-store-gst", 349900, "/year"],
      ["cheque-printing", 299900, "one-time"],
    ]);
    expect(items.map((i) => i.licenseTypes)).toEqual([
      ["trial", "annual", "one_time"],
      ["trial", "subscription", "multi"],
      ["trial", "annual", "one_time", "multi"],
      ["one_time", "multi"],
    ]);
    expect(items.map((i) => i.hasTrial)).toEqual([true, true, true, false]);
    expect(items[0]).toMatchObject({ categoryId: "pharmacy", categoryName: "Medical & Pharmacy", tone: "sage" });
    expect(items[0]?.latestReleaseAt).toBe(products[0]?.releases[0]?.releasedAt);
    expect(JSON.parse(JSON.stringify(items))).toEqual(items);
  });

  it("search text covers name, tagline, summary, category and feature titles (lower-cased)", () => {
    const med = items[0]!;
    expect(med.searchText).toContain("medical store billing software");
    expect(med.searchText).toContain("medical & pharmacy");
    expect(med.searchText).toContain("prescription register");
    expect(med.searchText).toBe(med.searchText.toLowerCase());
  });
});

describe("price bands (starting price EXCLUDING GST)", () => {
  it("uses the prototype thresholds, inclusive at both ends of the middle band", () => {
    expect(inPriceBand(299999, "under-3000")).toBe(true);
    expect(inPriceBand(300000, "under-3000")).toBe(false);
    expect(inPriceBand(300000, "3000-7000")).toBe(true);
    expect(inPriceBand(700000, "3000-7000")).toBe(true);
    expect(inPriceBand(700001, "3000-7000")).toBe(false);
    expect(inPriceBand(700000, "over-7000")).toBe(false);
    expect(inPriceBand(700001, "over-7000")).toBe(true);
    expect(inPriceBand(123, "any")).toBe(true);
  });

  it("puts products without a paid plan in 'Any price' only", () => {
    expect(inPriceBand(null, "any")).toBe(true);
    expect(inPriceBand(null, "under-3000")).toBe(false);
    expect(inPriceBand(null, "over-7000")).toBe(false);
  });

  it("keeps Cheque Printing (₹2,999 excl., ₹3,538.82 incl.) under ₹3,000", () => {
    expect(ids(filterCatalog(items, query({ price: "under-3000" })))).toEqual(["restaurant-billing", "cheque-printing"]);
    expect(ids(filterCatalog(items, query({ price: "3000-7000" })))).toEqual(["medical-billing", "general-store-gst"]);
    expect(filterCatalog(items, query({ price: "over-7000" }))).toEqual([]);
  });

  it("labels the bands as prototyped", () => {
    expect(Object.values(PRICE_BAND_LABELS)).toEqual(["Any price", "Under ₹3,000", "₹3,000 – ₹7,000", "Above ₹7,000"]);
  });
});

describe("search and filters", () => {
  it("matches a trimmed, case-insensitive substring", () => {
    expect(ids(filterCatalog(items, query({ q: "  KOT " })))).toEqual(["restaurant-billing"]);
    expect(ids(filterCatalog(items, query({ q: "batch & expiry" })))).toEqual(["medical-billing"]);
    expect(ids(filterCatalog(items, query({ q: "finance & office" })))).toEqual(["cheque-printing"]);
    expect(filterCatalog(items, query({ q: "zzzz" }))).toEqual([]);
    expect(filterCatalog(items, query({ q: "   " }))).toHaveLength(4);
  });

  it("ORs values within a group and ANDs across groups", () => {
    expect(ids(filterCatalog(items, query({ category: ["pharmacy", "finance"] })))).toEqual([
      "medical-billing",
      "cheque-printing",
    ]);
    expect(ids(filterCatalog(items, query({ os: ["macos", "android"] })))).toEqual([
      "restaurant-billing",
      "general-store-gst",
      "cheque-printing",
    ]);
    expect(ids(filterCatalog(items, query({ os: ["macos"], license: ["trial"] })))).toEqual(["general-store-gst"]);
    expect(ids(filterCatalog(items, query({ license: ["subscription", "annual"] })))).toEqual([
      "medical-billing",
      "restaurant-billing",
      "general-store-gst",
    ]);
  });

  it("can skip one group (for that group's counts)", () => {
    const q = query({ category: ["finance"], os: ["android"] });
    const rst = items[1]!;
    expect(matchesCatalogQuery(rst, q)).toBe(false);
    expect(matchesCatalogQuery(rst, q, "category")).toBe(true);
    expect(matchesCatalogQuery(rst, q, "os")).toBe(false);
  });
});

describe("facet counts", () => {
  it("shows the prototype's counts with no filters", () => {
    const f = catalogFacets(items, query(), categories);
    expect(counts(f.category)).toEqual({ pharmacy: 1, restaurant: 1, retail: 1, finance: 1, jewellery: 0, wholesale: 0, industry: 0 });
    expect(counts(f.availability)).toEqual({ all: null, available: 4, "coming-soon": 0 });
    expect(counts(f.price)).toEqual({ any: null, "under-3000": 2, "3000-7000": 2, "over-7000": 0 });
    expect(counts(f.os)).toEqual({ windows: 4, macos: 2, android: 1 });
    expect(counts(f.license)).toEqual({ trial: 3, one_time: 3, annual: 2, subscription: 1, multi: 3 });
    expect(f.price.find((o) => o.checked)?.value).toBe("any");
    expect(f.category.map((o) => o.label)).toEqual([
      "Medical & Pharmacy",
      "Restaurants & Cafés",
      "Retail & Grocery",
      "Finance & Office",
      "Jewellery",
      "Wholesale & Distribution",
      "Manufacturing & Logistics",
    ]);
    expect(f.availability.map((o) => o.label)).toEqual(["All", "Available now", "Coming soon"]);
    expect(f.os.map((o) => o.label)).toEqual(["Windows", "macOS", "Android"]);
    expect(f.license.map((o) => o.label)).toEqual(["Free trial", "One-time", "Annual", "Subscription", "Multi-device"]);
  });

  it("counts each option against every OTHER active filter (prototype: “billing” + Medical & Pharmacy)", () => {
    const q = query({ q: "billing", category: ["pharmacy"] });
    const f = catalogFacets(items, q, categories);
    expect(counts(f.category)).toEqual({ pharmacy: 1, restaurant: 1, retail: 1, finance: 0, jewellery: 0, wholesale: 0, industry: 0 });
    expect(counts(f.price)).toEqual({ any: null, "under-3000": 0, "3000-7000": 1, "over-7000": 0 });
    expect(counts(f.os)).toEqual({ windows: 1, macos: 0, android: 0 });
    expect(f.category.find((o) => o.value === "pharmacy")?.checked).toBe(true);
    expect(ids(filterCatalog(items, q))).toEqual(["medical-billing"]);
  });

  it("drops every count to 0 when the search matches nothing", () => {
    const f = catalogFacets(items, query({ q: "zzzz" }), categories);
    for (const group of [f.category, f.os, f.license]) for (const o of group) expect(o.count).toBe(0);
    expect(f.price.map((o) => o.count)).toEqual([null, 0, 0, 0]);
  });
});

describe("sorting", () => {
  it("offers the prototype's options in order", () => {
    expect(CATALOG_SORTS.map((s) => s.label)).toEqual([
      "Featured",
      "Price: low to high",
      "Price: high to low",
      "Name: A–Z",
      "Newest first",
    ]);
  });

  it("sorts by rank, starting price, name and latest release", () => {
    const shuffled = [items[3]!, items[1]!, items[0]!, items[2]!];
    expect(ids(sortCatalog(shuffled, "featured"))).toEqual(ids(items));
    expect(ids(sortCatalog(items, "price-asc"))).toEqual([
      "restaurant-billing",
      "cheque-printing",
      "general-store-gst",
      "medical-billing",
    ]);
    expect(ids(sortCatalog(items, "price-desc"))).toEqual([
      "medical-billing",
      "general-store-gst",
      "cheque-printing",
      "restaurant-billing",
    ]);
    expect(ids(sortCatalog(items, "name"))).toEqual([
      "cheque-printing",
      "general-store-gst",
      "medical-billing",
      "restaurant-billing",
    ]);
    // Newest = latest PUBLISHED release: GST 5.0.2 (30 Sep), MED 4.2.1 (15 Sep), RST 3.6.0 (28 Aug), CHQ 3.1.0 (5 Aug).
    expect(ids(sortCatalog(items, "newest"))).toEqual([
      "general-store-gst",
      "medical-billing",
      "restaurant-billing",
      "cheque-printing",
    ]);
  });

  it("puts products without a price or a release last, and never mutates its input", () => {
    const free = { ...items[0]!, id: "free", startingPricePaise: null, startingUnit: null, latestReleaseAt: null };
    const list = [free, ...items];
    expect(ids(sortCatalog(list, "price-asc")).at(-1)).toBe("free");
    expect(ids(sortCatalog(list, "price-desc")).at(-1)).toBe("free");
    expect(ids(sortCatalog(list, "newest")).at(-1)).toBe("free");
    expect(list[0]?.id).toBe("free");
  });
});

describe("URL state", () => {
  it("parses repeated and comma-separated values, dropping unknown ones", () => {
    const sp = new URLSearchParams(
      "q=gst+billing&category=pharmacy,nope&category=retail&availability=coming-soon&price=3000-7000&os=windows,linux&license=trial,multi,x&sort=newest",
    );
    expect(parseCatalogParams(sp, { categoryIds })).toEqual({
      q: "gst billing",
      category: ["pharmacy", "retail"],
      availability: "coming-soon",
      price: "3000-7000",
      os: ["windows"],
      license: ["trial", "multi"],
      sort: "newest",
    });
  });

  it("accepts the object Next passes as searchParams", () => {
    expect(parseCatalogParams({ category: "pharmacy", os: ["macos", "android"], q: ["a", "b"] }, { categoryIds })).toEqual(
      query({ q: "a", category: ["pharmacy"], os: ["macos", "android"] }),
    );
  });

  it("falls back to defaults for missing or malformed values", () => {
    expect(parseCatalogParams({}, { categoryIds })).toEqual(query());
    expect(parseCatalogParams(new URLSearchParams("price=cheap&sort=random&category=Pharmacy"))).toEqual(query());
    expect(parseCatalogParams(new URLSearchParams(`q=${"x".repeat(150)}`)).q).toHaveLength(100);
  });

  it("writes a canonical, readable query string that parses back to the same query", () => {
    const q = query({
      q: " gst & billing ",
      category: ["retail", "pharmacy"],
      price: "under-3000",
      os: ["macos"],
      license: ["trial", "annual"],
      sort: "price-desc",
    });
    const search = catalogSearch(q);
    expect(search).toBe(
      "?q=gst+%26+billing&category=retail,pharmacy&price=under-3000&os=macos&license=trial,annual&sort=price-desc",
    );
    expect(parseCatalogParams(new URLSearchParams(search), { categoryIds })).toEqual({ ...q, q: "gst & billing" });
    expect(catalogHref(query())).toBe("/software");
    expect(catalogHref(query({ category: ["pharmacy"] }))).toBe("/software?category=pharmacy");
  });
});

describe("query updates, chips and copy", () => {
  it("toggles values and ignores invalid ones", () => {
    const a = toggleFacetValue(query(), "os", "windows");
    expect(a.os).toEqual(["windows"]);
    expect(toggleFacetValue(a, "os", "windows").os).toEqual([]);
    expect(toggleFacetValue(a, "os", "linux")).toBe(a);
    expect(toggleFacetValue(a, "license", "multi").license).toEqual(["multi"]);
    expect(toggleFacetValue(a, "category", "retail").category).toEqual(["retail"]);
    expect(toggleFacetValue(a, "category", "Not a slug")).toBe(a);
  });

  it("clears the search and every filter but keeps the sort", () => {
    const q = query({ q: "x", category: ["pharmacy"], price: "over-7000", os: ["macos"], license: ["trial"], sort: "name" });
    expect(clearCatalogFilters(q)).toEqual(query({ sort: "name" }));
  });

  it("counts filters without the search text", () => {
    expect(activeFilterCount(query({ q: "x" }))).toBe(0);
    expect(activeFilterCount(query({ category: ["a", "b"], price: "under-3000", os: ["macos"], license: ["trial"] }))).toBe(5);
  });

  it("lists chips in prototype order and removes them one at a time", () => {
    const q = query({
      q: " billing ",
      category: ["pharmacy"],
      price: "3000-7000",
      os: ["windows"],
      license: ["multi"],
    });
    const chips = catalogChips(q, categories);
    expect(chips.map((c) => c.label)).toEqual(["“billing”", "Medical & Pharmacy", "₹3,000 – ₹7,000", "Windows", "Multi-device"]);
    expect(new Set(chips.map((c) => c.key)).size).toBe(chips.length);
    expect(removeCatalogChip(q, chips[0]!).q).toBe("");
    expect(removeCatalogChip(q, chips[1]!).category).toEqual([]);
    expect(removeCatalogChip(q, chips[2]!).price).toBe("any");
    expect(removeCatalogChip(q, chips[3]!).os).toEqual([]);
    expect(removeCatalogChip(q, chips[4]!).license).toEqual([]);
  });

  it("words the results label and the empty state like the prototype", () => {
    expect(resultCountLabel(1)).toBe("1 product");
    expect(resultCountLabel(0)).toBe("0 products");
    expect(resultCountLabel(4)).toBe("4 products");
    expect(emptyStateSubject(query({ q: " zzzz " }))).toBe("“zzzz”");
    expect(emptyStateSubject(query({ q: "zzzz", os: ["android"] }))).toBe("“zzzz” with these filters");
    expect(emptyStateSubject(query({ os: ["android"] }))).toBe("these filters");
    expect(COMPARE_LIMIT_MESSAGE).toBe("You can compare up to three products. Remove one to add another.");
  });
});

describe("compare model", () => {
  const all = products.map(toCompareProduct);
  const byId = (id: string) => all.find((p) => p.id === id)!;
  const cells = (rows: CompareRow[], label: string) => {
    const row = rows.find((r) => r.kind === "row" && r.label === label);
    return row?.kind === "row" ? row.cells.map((c) => (c.kind === "text" ? c.text : c.kind)) : undefined;
  };

  it("derives the licensing facts per product", () => {
    expect(all.map((p) => [p.id, p.maxDevices, p.trialDays, p.multiDevice, p.maintenance])).toEqual([
      ["medical-billing", 1, 15, false, true],
      ["restaurant-billing", 10, 7, true, false],
      ["general-store-gst", 5, 15, true, true],
      ["cheque-printing", 3, null, true, true],
    ]);
    expect(byId("medical-billing")).toMatchObject({
      latestVersion: "4.2.1",
      startingPricePaise: 499900,
      startingUnit: "/year",
      oneTime: true,
      annual: true,
      subscription: false,
    });
  });

  it("builds the prototype's rows: basics, licensing, the feature union, support", () => {
    const rows = compareRows([byId("medical-billing"), byId("restaurant-billing"), byId("general-store-gst")]);
    expect(rows.filter((r) => r.kind === "group").map((r) => r.label)).toEqual(["Basics", "Licensing", "Features", "Support"]);
    expect(cells(rows, "Category")).toEqual(["Medical & Pharmacy", "Restaurants & Cafés", "Retail & Grocery"]);
    expect(cells(rows, "Operating systems")).toEqual(["Windows", "Windows, Android", "Windows, macOS"]);
    expect(cells(rows, "Latest version")).toEqual(["v4.2.1", "v3.6.0", "v5.0.2"]);
    expect(cells(rows, "Free trial")).toEqual(["15 days", "7 days", "15 days"]);
    expect(cells(rows, "One-time license")).toEqual(["yes", "no", "yes"]);
    expect(cells(rows, "Subscription")).toEqual(["no", "yes", "no"]);
    expect(cells(rows, "Multi-device option")).toEqual(["no", "yes", "yes"]);
    expect(cells(rows, "Maintenance plan")).toEqual(["yes", "no", "yes"]);
    expect(cells(rows, "Most devices on one license")).toEqual(["1", "10", "5"]);
    expect(cells(rows, "Batch & expiry tracking")).toEqual(["yes", "no", "no"]);
    expect(cells(rows, "Multi-user access")).toEqual(["no", "no", "yes"]);
    expect(cells(rows, "Standard support")).toEqual(["yes", "yes", "yes"]);
    expect(cells(rows, "Demo on request")).toEqual(["yes", "yes", "yes"]);
    expect(rows.filter((r) => r.kind === "row")).toHaveLength(10 + 18 + 2);
  });

  it("shows a dash for a missing trial", () => {
    expect(cells(compareRows([byId("cheque-printing"), byId("medical-billing")]), "Free trial")).toEqual(["no", "15 days"]);
  });

  it("keeps up to three known, unique ids in slots", () => {
    expect(toSlots(["a", "b"])).toEqual(["a", "b", ""]);
    expect(toSlots(["medical-billing", "nope", "medical-billing", "cheque-printing"], all)).toEqual([
      "medical-billing",
      "cheque-printing",
      "",
    ]);
    expect(toSlots(["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
    expect(slotIds(["a", "", "c"])).toEqual(["a", "c"]);
    expect(defaultCompareIds(all)).toEqual(["medical-billing", "restaurant-billing"]);
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
    expect(joinNames(["A", "B"])).toBe("A and B");
  });
});
