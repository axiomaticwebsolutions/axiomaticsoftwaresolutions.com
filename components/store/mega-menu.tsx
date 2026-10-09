"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { STORE_PATHS, TONE_TILE_CLASSES, ariaCurrentFor, comingSoonLinkLabel, type NavProduct } from "@/components/store/active-nav";
import { COMING_SOON_CATALOG_HREF } from "@/lib/storefront/catalog-filter";
import { demoHref } from "@/lib/storefront/derive";
import { cn } from "@/lib/utils";

/**
 * Header nav item: 15px/600 (set on the nav), 10x12 padding, radius 10, lavender on hover and when active.
 * The active background goes last so a caller's base background (the Software trigger's bg-transparent) can't drop it.
 */
export function navItemClassName(active: boolean, className?: string): string {
  return cn(
    "inline-flex items-center rounded-10 px-3 py-2.5 text-ink no-underline transition-colors hover:bg-lavender-bg",
    className,
    active && "bg-lavender-bg",
  );
}

type MenuLink = { label: string; href: string };

/** Right column of the Software menu, after "Browse all software" (prototype order). */
const EXPLORE_LINKS: readonly MenuLink[] = [
  { label: "Compare products", href: STORE_PATHS.compare },
  { label: "Licensing explained", href: STORE_PATHS.pricing },
  { label: "Book a demo", href: demoHref() },
];

function linksIn(menu: HTMLElement | null): HTMLAnchorElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLAnchorElement>("a[href]")) : [];
}

export type MegaMenuProps = {
  products: readonly NavProduct[];
  /** COMING_SOON products: one small "N more coming soon" link under the list (none when 0). */
  comingSoonCount?: number;
  pathname: string;
  /** The current page is in the Software section (lavender trigger, aria-current). */
  active: boolean;
};

/**
 * "Software" disclosure in the primary nav: a button (aria-expanded/aria-controls) that opens the 640px menu of
 * products on sale (plus a "N more coming soon" link to the filtered catalog) and the Explore links. Click toggles;
 * Escape closes and returns focus to the button; a click outside or tabbing out closes; ArrowDown/ArrowUp open it and
 * move between links (Home/End jump). Closes on navigation.
 */
export function MegaMenu({ products, comingSoonCount = 0, pathname, active }: MegaMenuProps) {
  // Open state is tied to the path it was opened on, so navigating away closes the menu without an effect.
  const [openAt, setOpenAt] = React.useState<string | null>(null);
  const open = openAt === pathname;
  const pendingFocus = React.useRef<"first" | "last" | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();

  const openMenu = React.useCallback(
    (focus: "first" | "last" | null) => {
      pendingFocus.current = focus;
      setOpenAt(pathname);
    },
    [pathname],
  );

  const closeMenu = React.useCallback((returnFocus: boolean) => {
    pendingFocus.current = null;
    setOpenAt(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Keyboard opening moves focus into the menu once it is visible.
  React.useEffect(() => {
    if (!open || !pendingFocus.current) return;
    const links = linksIn(menuRef.current);
    (pendingFocus.current === "first" ? links[0] : links[links.length - 1])?.focus();
    pendingFocus.current = null;
  }, [open]);

  // While open: Escape anywhere closes it; a pointer press outside closes it.
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      closeMenu(rootRef.current?.contains(document.activeElement) ?? false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeMenu(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, closeMenu]);

  const focusEdge = (edge: "first" | "last") => {
    const links = linksIn(menuRef.current);
    (edge === "first" ? links[0] : links[links.length - 1])?.focus();
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const edge = event.key === "ArrowDown" ? "first" : "last";
    if (open) focusEdge(edge);
    else openMenu(edge);
  };

  // Arrow keys move between the menu links (Home/End jump); following a link closes the menu, including a link to
  // the page already shown. Native listeners: the menu is a plain disclosure region, not an interactive widget.
  React.useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const links = linksIn(menu);
      if (links.length === 0) return;
      event.preventDefault();
      const index = links.findIndex((link) => link === document.activeElement);
      let next = 0;
      if (event.key === "End") next = links.length - 1;
      else if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % links.length;
      else if (event.key === "ArrowUp") next = index <= 0 ? links.length - 1 : index - 1;
      links[next]?.focus();
    };
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) closeMenu(false);
    };
    menu.addEventListener("keydown", onKeyDown);
    menu.addEventListener("click", onClick);
    return () => {
      menu.removeEventListener("keydown", onKeyDown);
      menu.removeEventListener("click", onClick);
    };
  }, [open, closeMenu]);

  // Tabbing out (focus moving to an element outside the menu) closes it.
  const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (open && next instanceof Node && !rootRef.current?.contains(next)) closeMenu(false);
  };

  return (
    <div ref={rootRef} className="relative" onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-current={active ? "true" : undefined}
        onClick={() => (open ? closeMenu(false) : openMenu(null))}
        onKeyDown={onTriggerKeyDown}
        className={navItemClassName(active, "cursor-pointer gap-0.5 border-0 bg-transparent font-[inherit] aria-expanded:bg-lavender-bg")}
      >
        Software
        <Icon name="expand_more" size={20} className={cn("transition-transform duration-200", open && "rotate-180")} />
      </button>
      {/* Rendered while closed (hidden) so aria-controls always points at an element. */}
      <div
        ref={menuRef}
        id={menuId}
        hidden={!open}
        className="absolute left-[-12px] top-[52px] z-10 grid w-[640px] grid-cols-[minmax(0,1fr)_200px] gap-2 rounded-20 border border-line bg-surface p-3 text-left font-normal shadow-menu animate-enter-up"
      >
        <ul className="m-0 grid list-none content-start gap-1 p-0">
          {products.map((product) => (
            <li key={product.slug}>
              <Link
                href={product.href}
                aria-current={ariaCurrentFor(pathname, product.href)}
                className="flex items-start gap-3.5 rounded-14 p-3 text-ink no-underline transition-colors hover:bg-lavender-soft aria-[current=page]:bg-lavender-soft"
              >
                <span
                  aria-hidden="true"
                  className={cn("grid size-10 flex-none place-items-center rounded-12", TONE_TILE_CLASSES[product.tone])}
                >
                  <Icon name={product.icon} size={22} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14.5px] font-bold leading-[1.35]">{product.name}</span>
                  <span className="mt-[3px] block text-[13px] font-medium leading-[1.45] text-ink-2">{product.tagline}</span>
                </span>
              </Link>
            </li>
          ))}
          {comingSoonCount > 0 ? (
            <li>
              <Link
                href={COMING_SOON_CATALOG_HREF}
                className="flex items-center gap-2 rounded-12 px-3 py-2.5 text-[13.5px] font-bold text-lavender-fg no-underline transition-colors hover:bg-lavender-soft"
              >
                <Icon name="schedule" size={18} />
                {comingSoonLinkLabel(comingSoonCount)} <span aria-hidden="true">→</span>
              </Link>
            </li>
          ) : null}
        </ul>
        <div className="flex flex-col gap-3 rounded-14 bg-bg p-4 text-[14px] leading-[1.35]">
          <p className="m-0 text-[11.5px] font-bold uppercase leading-[1.35] tracking-[0.12em] text-ink-2">Explore</p>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            <li>
              <Link
                href={STORE_PATHS.software}
                aria-current={ariaCurrentFor(pathname, STORE_PATHS.software)}
                className="font-bold text-primary-link no-underline hover:text-primary-link-hover hover:underline"
              >
                Browse all software <span aria-hidden="true">→</span>
              </Link>
            </li>
            {EXPLORE_LINKS.map((link) => (
              <li key={link.label}>
                <Link
                  href={link.href}
                  aria-current={ariaCurrentFor(pathname, link.href)}
                  className="font-semibold text-ink no-underline hover:text-primary-link hover:underline"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
