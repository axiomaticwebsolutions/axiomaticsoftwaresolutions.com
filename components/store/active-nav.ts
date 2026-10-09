/**
 * Storefront navigation model: the header's links, which header item a pathname belongs to, the aria-current value
 * for a link, the plain product rows the menus render, the "Coming soon" directory grouped by category, and where the
 * Software menu sits. Pure and client-safe (header, mobile panel, footer, tests).
 */
import { ICON_PATHS, type IconName } from "@/components/icons/registry";
import type { Tone } from "@/lib/design/tokens";
import { demoHref, productHref } from "@/lib/storefront/derive";

/** Header items that can be highlighted. Home and pages outside the nav (contact, legal, orders) highlight nothing. */
export type StoreNavKey = "software" | "pricing" | "resources" | "support";

/**
 * Path prefixes per item, from the `active` prop each prototype page passes to Site Header: Software, Product, Compare
 * and Cart -> software; Pricing -> pricing; Docs and About -> resources; Support -> support.
 */
const SECTIONS: ReadonlyArray<readonly [StoreNavKey, readonly string[]]> = [
  ["software", ["/software", "/compare", "/cart"]],
  ["pricing", ["/pricing"]],
  ["resources", ["/docs", "/about"]],
  ["support", ["/support"]],
];

export const STORE_PATHS = {
  home: "/",
  software: "/software",
  compare: "/compare",
  pricing: "/pricing",
  cart: "/cart",
  signIn: "/sign-in",
} as const;

export type HeaderLink = { key: StoreNavKey; label: string; href: string };

/** Tinted icon tile colours per tone (bg + fg pairs meet 4.5:1). Client-safe, so server components can use it too. */
export const TONE_TILE_CLASSES: Readonly<Record<Tone, string>> = {
  lavender: "bg-lavender-bg text-lavender-fg",
  sage: "bg-sage-bg text-sage-fg",
  blue: "bg-blue-bg text-blue-fg",
  peach: "bg-peach-bg text-peach-fg",
  pink: "bg-pink-bg text-pink-fg",
};

/** Plain header links after the Software menu, in prototype order. */
export const HEADER_LINKS: readonly HeaderLink[] = [
  { key: "pricing", label: "Pricing", href: "/pricing" },
  { key: "resources", label: "Resources", href: "/docs" },
  { key: "support", label: "Support", href: "/support" },
];

/** Path only: no query or hash, no duplicate or trailing slashes ("/" stays "/"). */
export function normalizePath(pathname: string | null | undefined): string {
  if (!pathname) return "/";
  let path = pathname.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The header item to highlight for a pathname, or null (home, contact, legal, orders, unknown pages). */
export function activeNavFor(pathname: string | null | undefined): StoreNavKey | null {
  const path = normalizePath(pathname);
  for (const [key, prefixes] of SECTIONS) {
    if (prefixes.some((prefix) => within(path, prefix))) return key;
  }
  return null;
}

/**
 * aria-current for a navigation link: "page" when it points at the current page, "true" when it is the highlighted
 * item of the section the page belongs to (e.g. Resources on /docs/install), otherwise undefined.
 */
export function ariaCurrentFor(
  pathname: string | null | undefined,
  href: string,
  section?: StoreNavKey,
): "page" | "true" | undefined {
  const path = normalizePath(pathname);
  if (path === normalizePath(href)) return "page";
  if (section && activeNavFor(path) === section) return "true";
  return undefined;
}

/** A product row in the Software menu, the mobile panel and the footer. Plain data, safe to pass to client code. */
export type NavProduct = {
  slug: string;
  name: string;
  shortName: string;
  tagline: string;
  icon: IconName;
  tone: Tone;
  href: string;
};

/** The StoreProduct fields the menus need (structural, so the server can pass StoreProduct[] directly). */
export type NavProductSource = { id: string; name: string; shortName: string; tagline: string; icon: string; tone: Tone };

const FALLBACK_ICON: IconName = "storefront";

/** A Material Symbols name from data, or the fallback when the curated registry does not include it. */
export function toIconName(name: string | null | undefined, fallback: IconName = FALLBACK_ICON): IconName {
  return name && Object.hasOwn(ICON_PATHS, name) ? (name as IconName) : fallback;
}

/** Strips products down to what the header and footer render (keeps the given order: rank). */
export function toNavProducts(products: readonly NavProductSource[]): NavProduct[] {
  return products.map((p) => ({
    slug: p.id,
    name: p.name,
    shortName: p.shortName,
    tagline: p.tagline,
    icon: toIconName(p.icon),
    tone: p.tone,
    href: productHref(p.id),
  }));
}

// ---------- Software menu: "Coming soon" directory ----------

/** A COMING_SOON product in the menus' "Coming soon" directory: a name and an icon, no tagline (small payload). */
export type NavComingSoonProduct = { slug: string; shortName: string; icon: IconName; tone: Tone; href: string };

/** One category of the directory: its coming-soon products by rank. */
export type NavComingSoonGroup = { id: string; name: string; products: NavComingSoonProduct[] };

/** The StoreProduct fields the directory needs (structural, so the server can pass StoreProduct[] directly). */
export type NavComingSoonSource = {
  id: string;
  name: string;
  shortName: string;
  icon: string;
  tone: Tone;
  rank: number;
  category: { id: string; name: string };
};

/** The StoreCategory fields that order the directory. */
export type NavCategorySource = { id: string; name: string; sortOrder: number };

/**
 * The "Coming soon" directory: coming-soon products grouped by category, categories by sortOrder (then name), products
 * by rank (then name). Categories without coming-soon products are left out. A product whose category is missing from
 * `categories` (the two lists are cached separately) still shows, in a group named after its own category, after the
 * known ones. The short name falls back to the full name when empty.
 */
export function groupComingSoonByCategory(
  products: readonly NavComingSoonSource[],
  categories: readonly NavCategorySource[],
): NavComingSoonGroup[] {
  const groups = new Map<string, NavComingSoonGroup>();
  const orderedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  for (const c of orderedCategories) groups.set(c.id, { id: c.id, name: c.name, products: [] });
  const ordered = [...products].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  for (const p of ordered) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    let group = groups.get(p.category.id);
    if (!group) {
      group = { id: p.category.id, name: p.category.name, products: [] };
      groups.set(p.category.id, group);
    }
    group.products.push({
      slug: p.id,
      shortName: p.shortName.trim() || p.name,
      icon: toIconName(p.icon),
      tone: p.tone,
      href: productHref(p.id),
    });
  }
  return [...groups.values()].filter((g) => g.products.length > 0);
}

/** Coming-soon products across the directory. */
export function comingSoonTotal(groups: readonly NavComingSoonGroup[]): number {
  return groups.reduce((n, g) => n + g.products.length, 0);
}

/** Columns of the desktop "Coming soon" directory (the panel is at least 896px wide from the nav breakpoint). */
export const COMING_SOON_COLUMNS = 3;

/**
 * Splits the directory into balanced columns for the desktop menu, masonry style: each group, in category order, goes
 * into the column that is shortest so far (the leftmost on a tie), a group weighing its heading plus one row per
 * product. The first categories head the columns, the last ones end up lowest, and a group never splits. Columns are
 * read top to bottom, left to right (DOM order). Empty columns are left out; the caller keeps the column width.
 */
export function balanceComingSoonColumns<T extends { products: readonly unknown[] }>(
  groups: readonly T[],
  count: number = COMING_SOON_COLUMNS,
): T[][] {
  const columns = Array.from({ length: Math.max(1, Math.floor(count)) }, () => ({ height: 0, groups: [] as T[] }));
  for (const group of groups) {
    const shortest = columns.reduce((best, column) => (column.height < best.height ? column : best));
    shortest.groups.push(group);
    shortest.height += 1 + group.products.length;
  }
  return columns.map((c) => c.groups).filter((c) => c.length > 0);
}

/** Accessible name of a category button in the mobile panel: "<category>, N products". */
export function comingSoonCategoryName(name: string, count: number): string {
  return `${name}, ${count} ${count === 1 ? "product" : "products"}`;
}

/**
 * End of every coming-soon link's accessible name (its aria-label), so the link is clear out of context, e.g. in a
 * screen reader's links list: "Payroll & Attendance, coming soon". The name starts with the visible text (WCAG 2.5.3).
 */
export const COMING_SOON_LINK_SUFFIX = ", coming soon";

/** The accessible name (aria-label) of a coming-soon link: its visible short name, then the suffix. */
export function comingSoonLinkName(shortName: string): string {
  return `${shortName}${COMING_SOON_LINK_SUFFIX}`;
}

/** The link to the coming-soon view of the catalog, after the directory (desktop menu and mobile panel). */
export const SEE_ALL_COMING_SOON_LABEL = "See all coming soon";

/** Section labels of the Software menu and the mobile panel. */
export const SOFTWARE_MENU_SECTIONS = { available: "Available now", comingSoon: "Coming soon" } as const;

/** The catalog link that starts the Software menu's bottom bar and follows the products in the mobile panel. */
export const BROWSE_ALL_SOFTWARE_LABEL = "Browse all software";

export type MenuLink = { label: string; href: string };

/** Bottom bar of the Software menu, after "Browse all software" (the prototype's Explore links, in order). */
export const SOFTWARE_MENU_LINKS: readonly MenuLink[] = [
  { label: "Compare products", href: STORE_PATHS.compare },
  { label: "Licensing explained", href: STORE_PATHS.pricing },
  { label: "Book a demo", href: demoHref() },
];

// ---------- Software menu: placement ----------

/** Widest Software menu, in px (the panel is `min(920px, 100vw - 64px)`: 100vw counts a classic scrollbar). */
export const SOFTWARE_MENU_MAX_WIDTH = 920;

/**
 * Smallest gap between the open Software menu and either side of the viewport, in px: the header container's side
 * padding, so a panel that has to move left ends in line with the header's right edge ("Request a demo").
 */
export const SOFTWARE_MENU_GUTTER = 24;

/** Preferred left edge of the menu relative to its trigger: the first tile's icon lines up under "Software". */
export const SOFTWARE_MENU_OFFSET = -12;

/**
 * Left offset (px, relative to the trigger's wrapper) for the open Software menu: the preferred offset under the
 * trigger, moved left just enough to keep the right edge `SOFTWARE_MENU_GUTTER` inside the viewport, and never past
 * the left gutter (which wins when the menu is wider than the space between the gutters).
 */
export function softwareMenuLeft({
  triggerLeft,
  menuWidth,
  viewportWidth,
}: {
  /** The trigger wrapper's left edge in the viewport. */
  triggerLeft: number;
  menuWidth: number;
  /** document.documentElement.clientWidth (without the scrollbar). */
  viewportWidth: number;
}): number {
  const rightmost = viewportWidth - SOFTWARE_MENU_GUTTER - menuWidth - triggerLeft;
  const leftmost = SOFTWARE_MENU_GUTTER - triggerLeft;
  return Math.round(Math.max(leftmost, Math.min(SOFTWARE_MENU_OFFSET, rightmost)));
}
