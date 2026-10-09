/**
 * Storefront navigation model: the header's links, which header item a pathname belongs to, the aria-current value
 * for a link, and the plain product rows the menus render. Pure and client-safe (header, mobile panel, footer, tests).
 */
import { ICON_PATHS, type IconName } from "@/components/icons/registry";
import type { Tone } from "@/lib/design/tokens";
import { productHref } from "@/lib/storefront/derive";

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

/** "20 more coming soon" / "1 more coming soon" (the Software menu and the mobile panel). */
export function comingSoonLinkLabel(count: number): string {
  return `${count} more coming soon`;
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
