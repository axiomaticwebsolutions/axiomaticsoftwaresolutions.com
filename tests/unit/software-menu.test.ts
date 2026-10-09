/**
 * Software menu, design C "Featured + directory" (decisions.md 2026-10-09, owner request): the "Coming soon"
 * directory model (grouping and order), the link names and labels, the bottom bar links and where the panel sits.
 * The component behaviour (keyboard, Escape, outside click) is covered by tests/e2e/store-menu.spec.ts and
 * scripts/check-a11y.mjs (store).
 */
import { describe, expect, it } from "vitest";
import {
  BROWSE_ALL_SOFTWARE_LABEL,
  COMING_SOON_COLUMNS,
  COMING_SOON_LINK_SUFFIX,
  SEE_ALL_COMING_SOON_LABEL,
  SOFTWARE_MENU_GUTTER,
  SOFTWARE_MENU_LINKS,
  SOFTWARE_MENU_MAX_WIDTH,
  SOFTWARE_MENU_OFFSET,
  SOFTWARE_MENU_SECTIONS,
  balanceComingSoonColumns,
  comingSoonCategoryName,
  comingSoonLinkName,
  comingSoonTotal,
  groupComingSoonByCategory,
  softwareMenuLeft,
  type NavCategorySource,
  type NavComingSoonSource,
} from "@/components/store/active-nav";
import { COMING_SOON_CATALOG_HREF } from "@/lib/storefront/catalog-filter";
import { fixtureCategories, fixtureComingSoonProducts } from "@/lib/storefront/fixtures";

const categories: NavCategorySource[] = [
  { id: "retail", name: "Retail & Grocery", sortOrder: 2 },
  { id: "pharmacy", name: "Medical & Pharmacy", sortOrder: 0 },
  { id: "finance", name: "Finance & Office", sortOrder: 3 },
  { id: "empty", name: "No coming-soon products", sortOrder: 1 },
];

function product(id: string, rank: number, categoryId: string, extra: Partial<NavComingSoonSource> = {}): NavComingSoonSource {
  return {
    id,
    name: `${id} full name`,
    shortName: id,
    icon: "storefront",
    tone: "blue",
    rank,
    category: { id: categoryId, name: categories.find((c) => c.id === categoryId)?.name ?? `${categoryId} (new)` },
    ...extra,
  };
}

describe("groupComingSoonByCategory", () => {
  it("groups by category in sortOrder, products by rank, and leaves out empty categories", () => {
    const groups = groupComingSoonByCategory(
      [product("c", 103, "retail"), product("a", 101, "finance"), product("b", 102, "retail"), product("d", 104, "pharmacy")],
      categories,
    );
    expect(groups.map((g) => [g.id, g.name, g.products.map((p) => p.slug)])).toEqual([
      ["pharmacy", "Medical & Pharmacy", ["d"]],
      ["retail", "Retail & Grocery", ["b", "c"]],
      ["finance", "Finance & Office", ["a"]],
    ]);
  });

  it("breaks ties by name (categories) and name (products)", () => {
    const tied: NavCategorySource[] = [
      { id: "z", name: "Zeta", sortOrder: 0 },
      { id: "a", name: "Alpha", sortOrder: 0 },
    ];
    const groups = groupComingSoonByCategory(
      [product("p2", 5, "z", { name: "Beta" }), product("p1", 5, "z", { name: "Alpha" }), product("p3", 1, "a")],
      tied,
    );
    expect(groups.map((g) => g.id)).toEqual(["a", "z"]);
    expect(groups[1]?.products.map((p) => p.slug)).toEqual(["p1", "p2"]);
  });

  it("maps each product to a small link row: short name (or the name), registry icon, tone and URL", () => {
    const [group] = groupComingSoonByCategory(
      [
        product("payroll", 1, "finance", { shortName: "Payroll & Attendance", icon: "badge", tone: "lavender" }),
        product("unnamed", 2, "finance", { shortName: "  ", name: "Unnamed Product", icon: "not_an_icon" }),
      ],
      categories,
    );
    expect(group?.products).toEqual([
      { slug: "payroll", shortName: "Payroll & Attendance", icon: "badge", tone: "lavender", href: "/software/payroll" },
      { slug: "unnamed", shortName: "Unnamed Product", icon: "storefront", tone: "blue", href: "/software/unnamed" },
    ]);
    // Small payload: no tagline, summary, features or category inside the rows.
    expect(Object.keys(group?.products[0] ?? {}).sort()).toEqual(["href", "icon", "shortName", "slug", "tone"]);
  });

  it("keeps a product whose category is not in the list, after the known categories", () => {
    const groups = groupComingSoonByCategory([product("x", 1, "brand-new"), product("y", 2, "retail")], categories);
    expect(groups.map((g) => [g.id, g.name])).toEqual([
      ["retail", "Retail & Grocery"],
      ["brand-new", "brand-new (new)"],
    ]);
  });

  it("lists a product once and returns [] without coming-soon products", () => {
    const groups = groupComingSoonByCategory([product("a", 1, "retail"), product("a", 1, "retail")], categories);
    expect(comingSoonTotal(groups)).toBe(1);
    expect(groupComingSoonByCategory([], categories)).toEqual([]);
    expect(comingSoonTotal([])).toBe(0);
  });

  it("groups the seeded coming-soon catalog into its 7 categories (20 products, every icon in the registry)", () => {
    const source = fixtureComingSoonProducts();
    const groups = groupComingSoonByCategory(source, fixtureCategories());
    expect(groups.map((g) => [g.name, g.products.length])).toEqual([
      ["Medical & Pharmacy", 3],
      ["Restaurants & Cafés", 1],
      ["Retail & Grocery", 6],
      ["Finance & Office", 3],
      ["Jewellery", 1],
      ["Wholesale & Distribution", 3],
      ["Manufacturing & Logistics", 3],
    ]);
    expect(comingSoonTotal(groups)).toBe(source.length);
    const rows = groups.flatMap((g) => g.products);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(source.length);
    for (const row of rows) expect(row.icon, row.slug).toBe(source.find((p) => p.id === row.slug)?.icon);
    // Within a category the order is the catalog rank.
    for (const g of groups) {
      const ranks = g.products.map((r) => source.find((p) => p.id === r.slug)?.rank ?? 0);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
});

describe("balanceComingSoonColumns", () => {
  const group = (id: string, size: number) => ({ id, products: Array.from({ length: size }, (_, i) => `${id}${i}`) });
  const ids = (columns: { id: string }[][]) => columns.map((c) => c.map((g) => g.id));
  // A column's height in rows: one heading plus one row per product for each group.
  const heights = (columns: { products: unknown[] }[][]) => columns.map((c) => c.reduce((n, g) => n + 1 + g.products.length, 0));

  it("puts each group, in order, into the shortest column so far (the leftmost on a tie)", () => {
    const columns = balanceComingSoonColumns([group("a", 3), group("b", 1), group("c", 6), group("d", 3), group("e", 1)], 3);
    expect(ids(columns)).toEqual([["a", "e"], ["b", "d"], ["c"]]);
    expect(heights(columns)).toEqual([6, 6, 7]);
  });

  it("balances the seeded directory better than contiguous columns (tallest 10 rows, not 11)", () => {
    const groups = groupComingSoonByCategory(fixtureComingSoonProducts(), fixtureCategories());
    const columns = balanceComingSoonColumns(groups);
    expect(COMING_SOON_COLUMNS).toBe(3);
    expect(columns.map((c) => c.map((g) => g.name))).toEqual([
      ["Medical & Pharmacy", "Jewellery", "Wholesale & Distribution"],
      ["Restaurants & Cafés", "Finance & Office", "Manufacturing & Logistics"],
      ["Retail & Grocery"],
    ]);
    expect(Math.max(...heights(columns))).toBe(10);
    // Every group once; the first categories head the columns.
    expect(columns.flat().map((g) => g.id).sort()).toEqual(groups.map((g) => g.id).sort());
    expect(columns.map((c) => c[0]?.id)).toEqual(groups.slice(0, 3).map((g) => g.id));
  });

  it("leaves out empty columns and copes with a bad column count", () => {
    expect(ids(balanceComingSoonColumns([group("a", 2)], 3))).toEqual([["a"]]);
    expect(balanceComingSoonColumns([], 3)).toEqual([]);
    expect(ids(balanceComingSoonColumns([group("a", 1), group("b", 1)], 0))).toEqual([["a", "b"]]);
  });
});

describe("Software menu copy and links", () => {
  it("names each coming-soon link so it is clear out of context", () => {
    expect(COMING_SOON_LINK_SUFFIX).toBe(", coming soon");
    expect(comingSoonLinkName("Clinic OPD")).toBe("Clinic OPD, coming soon");
  });

  it("names the mobile category buttons with their product count", () => {
    expect(comingSoonCategoryName("Jewellery", 1)).toBe("Jewellery, 1 product");
    expect(comingSoonCategoryName("Retail & Grocery", 6)).toBe("Retail & Grocery, 6 products");
  });

  it("labels the sections and links the directory to the coming-soon view of the catalog", () => {
    expect(SOFTWARE_MENU_SECTIONS).toEqual({ available: "Available now", comingSoon: "Coming soon" });
    expect(SEE_ALL_COMING_SOON_LABEL).toBe("See all coming soon");
    expect(COMING_SOON_CATALOG_HREF).toBe("/software?availability=coming-soon");
  });

  it("starts the bottom bar with the catalog link, then the Explore links in prototype order", () => {
    expect(BROWSE_ALL_SOFTWARE_LABEL).toBe("Browse all software");
    expect(SOFTWARE_MENU_LINKS).toEqual([
      { label: "Compare products", href: "/compare" },
      { label: "Licensing explained", href: "/pricing" },
      { label: "Book a demo", href: "/contact?type=demo" },
    ]);
  });
});

describe("softwareMenuLeft", () => {
  it("sits under the trigger when the panel fits", () => {
    expect(softwareMenuLeft({ triggerLeft: 280, menuWidth: 920, viewportWidth: 1263 })).toBe(SOFTWARE_MENU_OFFSET);
    expect(softwareMenuLeft({ triggerLeft: 600, menuWidth: 920, viewportWidth: 1903 })).toBe(SOFTWARE_MENU_OFFSET);
  });

  it("moves left just enough to keep the right edge inside the viewport", () => {
    const left = softwareMenuLeft({ triggerLeft: 260, menuWidth: 920, viewportWidth: 1009 });
    expect(260 + left + 920).toBe(1009 - SOFTWARE_MENU_GUTTER);
  });

  it("never passes the left gutter (it wins when the panel is wider than the room)", () => {
    const left = softwareMenuLeft({ triggerLeft: 250, menuWidth: 960, viewportWidth: 960 });
    expect(250 + left).toBe(SOFTWARE_MENU_GUTTER);
  });

  // Trigger's left edge: the 1240px store container, its 24px padding, the logo (about 215px) and the 32px gap.
  it.each([
    [960, 0],
    [960, 17],
    [1024, 17],
    [1280, 17],
    [1366, 17],
    [1440, 0],
    [1920, 17],
  ])("stays inside a %ipx window (scrollbar %ipx)", (windowWidth, scrollbar) => {
    const viewportWidth = windowWidth - scrollbar;
    const menuWidth = Math.min(SOFTWARE_MENU_MAX_WIDTH, windowWidth - 64);
    const containerLeft = Math.max(0, (viewportWidth - 1240) / 2);
    const triggerLeft = containerLeft + 24 + 215 + 32;
    const left = triggerLeft + softwareMenuLeft({ triggerLeft, menuWidth, viewportWidth });
    expect(left).toBeGreaterThanOrEqual(SOFTWARE_MENU_GUTTER);
    expect(left + menuWidth).toBeLessThanOrEqual(viewportWidth - SOFTWARE_MENU_GUTTER + 1);
  });
});
