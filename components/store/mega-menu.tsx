"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import {
  BROWSE_ALL_SOFTWARE_LABEL,
  SEE_ALL_COMING_SOON_LABEL,
  SOFTWARE_MENU_LINKS,
  SOFTWARE_MENU_SECTIONS,
  STORE_PATHS,
  TONE_TILE_CLASSES,
  ariaCurrentFor,
  balanceComingSoonColumns,
  comingSoonLinkName,
  softwareMenuLeft,
  type NavComingSoonGroup,
  type NavProduct,
} from "@/components/store/active-nav";
import { COMING_SOON_CATALOG_HREF } from "@/lib/storefront/catalog-filter";
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

/** Uppercase section label of the menu (12px/800, like the group labels of the docs and legal sidebars). */
const SECTION_LABEL_CLASS = "m-0 text-[12px] font-extrabold uppercase leading-[normal] tracking-[0.08em] text-ink-2";

const NO_GROUPS: readonly NavComingSoonGroup[] = [];

/** Short windows (the panel would scroll): slightly tighter rows, so more of the directory fits. */
const SHORT_WINDOW_TILE = "[@media(max-height:760px)]:py-2";
const SHORT_WINDOW_ROW = "[@media(max-height:760px)]:py-px";

function linksIn(menu: HTMLElement | null): HTMLAnchorElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLAnchorElement>("a[href]")) : [];
}

export type MegaMenuProps = {
  /** PUBLISHED products by rank: the "Available now" tiles (the section is left out when empty). */
  products: readonly NavProduct[];
  /** COMING_SOON products by category: the "Coming soon" directory (left out when empty). */
  comingSoon?: readonly NavComingSoonGroup[];
  pathname: string;
  /** The current page is in the Software section (lavender trigger, aria-current). */
  active: boolean;
};

/**
 * "Software" disclosure in the primary nav (design C, "Featured + directory"): a button (aria-expanded/aria-controls)
 * that opens a panel of up to 920px with the products on sale as tiles ("Available now"), every coming-soon product
 * as a compact directory grouped by category in three balanced columns ("Coming soon", with "See all coming soon"),
 * and a bottom bar with "Browse all software" and the Explore links. The panel sits under the trigger and moves left
 * just enough to stay 24px inside the viewport (in line with the header's edge); on short windows the product
 * sections scroll inside while the bottom bar stays in view. Click toggles; Escape closes and
 * returns focus to the button; a click outside or tabbing out closes; ArrowDown/ArrowUp open it and move through every
 * link in DOM order (Home/End jump). Closes on navigation.
 */
export function MegaMenu({ products, comingSoon = NO_GROUPS, pathname, active }: MegaMenuProps) {
  // Open state is tied to the path it was opened on, so navigating away closes the menu without an effect.
  const [openAt, setOpenAt] = React.useState<string | null>(null);
  const open = openAt === pathname;
  const pendingFocus = React.useRef<"first" | "last" | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();
  const columns = React.useMemo(() => balanceComingSoonColumns(comingSoon), [comingSoon]);

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

  // Placement before paint: under the trigger, moved left when the right edge would leave the viewport. On short
  // windows the product sections scroll: `data-more` fades their bottom edge while more of them is below.
  React.useLayoutEffect(() => {
    const menu = menuRef.current;
    const root = rootRef.current;
    const scroller = scrollRef.current;
    if (!open || !menu || !root) return;
    const markMore = () => {
      if (scroller) scroller.toggleAttribute("data-more", scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1);
    };
    const place = () => {
      const left = softwareMenuLeft({
        triggerLeft: root.getBoundingClientRect().left,
        menuWidth: menu.offsetWidth,
        viewportWidth: document.documentElement.clientWidth,
      });
      menu.style.left = `${left}px`;
      markMore();
    };
    place();
    window.addEventListener("resize", place);
    scroller?.addEventListener("scroll", markMore, { passive: true });
    return () => {
      window.removeEventListener("resize", place);
      scroller?.removeEventListener("scroll", markMore);
    };
  }, [open]);

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


  const availableId = `${menuId}-available`;
  const comingSoonId = `${menuId}-coming-soon`;

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
        className={cn(
          "absolute left-[-12px] top-[52px] z-10 flex w-[min(920px,calc(100vw-64px))] flex-col overflow-hidden rounded-20 border border-line bg-surface text-left font-normal shadow-menu animate-enter-up",
          // Never taller than the window below the sticky header.
          "max-h-[calc(100dvh-var(--store-header-h,108px)-24px)]",
        )}
      >
        {/*
          Safety net for short windows: the product sections scroll inside and the bottom bar stays in view. While more
          is below, the last 36px fade out (data-more) so a cut row reads as "scroll for more"; the scroll padding keeps
          a focused link and its 4px focus ring clear of both edges and of the fade.
        */}
        <div
          ref={scrollRef}
          className={cn(
            "min-h-0 scroll-pb-10 scroll-pt-2 overflow-y-auto overscroll-contain p-3 pb-2 scrollbar-subtle",
            "data-[more]:[mask-image:linear-gradient(to_bottom,#000_calc(100%-36px),transparent)]",
          )}
        >
          {products.length > 0 ? (
            <div role="group" aria-labelledby={availableId}>
              <p id={availableId} className={cn(SECTION_LABEL_CLASS, "px-3 pb-2 pt-2")}>
                {SOFTWARE_MENU_SECTIONS.available}
              </p>
              <ul className="m-0 grid list-none grid-cols-2 gap-1 p-0">
                {products.map((product) => (
                  <li key={product.slug} className="grid">
                    <Link
                      href={product.href}
                      aria-current={ariaCurrentFor(pathname, product.href)}
                      className={cn(
                        "flex items-start gap-3.5 rounded-14 px-3 py-2.5 text-ink no-underline transition-colors hover:bg-lavender-soft aria-[current=page]:bg-lavender-soft",
                        SHORT_WINDOW_TILE,
                      )}
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
              </ul>
            </div>
          ) : null}
          {comingSoon.length > 0 ? (
            <div
              role="group"
              aria-labelledby={comingSoonId}
              className={cn(products.length > 0 && "mt-2 border-t border-line-subtle pt-3")}
            >
              <div className="flex items-center justify-between gap-4 px-3 pb-2">
                <p id={comingSoonId} className={cn(SECTION_LABEL_CLASS, "py-1")}>
                  {SOFTWARE_MENU_SECTIONS.comingSoon}
                </p>
                <Link
                  href={COMING_SOON_CATALOG_HREF}
                  className="-mr-2 rounded-8 px-2 py-1 text-[13px] font-bold leading-[1.35] text-primary-link no-underline transition-colors hover:bg-lavender-soft hover:text-primary-link-hover"
                >
                  {SEE_ALL_COMING_SOON_LABEL} <span aria-hidden="true">→</span>
                </Link>
              </div>
              {/*
                Category groups in three balanced columns (balanceComingSoonColumns: each group goes to the shortest
                column, in category order); a group never splits. Names keep to one line and only wrap (up to two lines)
                when the user's text spacing makes them longer, so nothing is cut off.
              */}
              <div className="grid grid-cols-3 gap-x-6 px-1">
                {columns.map((column) => (
                  <div key={column[0]?.id} className="min-w-0">
                    {column.map((group) => {
                      const labelId = `${menuId}-category-${group.id}`;
                      return (
                        <div key={group.id} role="group" aria-labelledby={labelId} className="mb-3 last:mb-0">
                          <p
                            id={labelId}
                            className="m-0 line-clamp-2 px-2 pb-1 text-[13px] font-bold leading-[1.4] text-ink [overflow-wrap:anywhere]"
                          >
                            {group.name}
                          </p>
                          <ul className="m-0 grid list-none gap-px p-0">
                            {group.products.map((product) => (
                              <li key={product.slug} className="grid min-w-0">
                                {/* No prefetch: ~20 directory links would all prefetch on every opening. */}
                                <Link
                                  href={product.href}
                                  prefetch={false}
                                  aria-label={comingSoonLinkName(product.shortName)}
                                  aria-current={ariaCurrentFor(pathname, product.href)}
                                  className={cn(
                                    "flex min-w-0 items-center gap-2 rounded-8 px-2 py-0.5 text-[13.5px] font-semibold leading-[1.45] text-ink-2 no-underline transition-colors hover:bg-lavender-soft hover:text-ink aria-[current=page]:bg-lavender-soft aria-[current=page]:text-ink",
                                    SHORT_WINDOW_ROW,
                                  )}
                                >
                                  <span
                                    aria-hidden="true"
                                    className={cn(
                                      "grid size-[22px] flex-none place-items-center rounded-6",
                                      TONE_TILE_CLASSES[product.tone],
                                    )}
                                  >
                                    <Icon name={product.icon} size={14} />
                                  </span>
                                  <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{product.shortName}</span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div
          className={cn(
            // px-3: the text lines up with the section labels and the directory above.
            "m-3 flex flex-none flex-wrap items-center gap-x-6 gap-y-2 rounded-14 bg-bg px-3 py-3 text-[14px] leading-[1.35]",
            (products.length > 0 || comingSoon.length > 0) && "mt-1",
          )}
        >
          <Link
            href={STORE_PATHS.software}
            aria-current={ariaCurrentFor(pathname, STORE_PATHS.software)}
            className="font-bold text-primary-link no-underline hover:text-primary-link-hover hover:underline"
          >
            {BROWSE_ALL_SOFTWARE_LABEL} <span aria-hidden="true">→</span>
          </Link>
          <ul className="m-0 ml-auto flex list-none flex-wrap items-center gap-x-6 gap-y-2 p-0">
            {SOFTWARE_MENU_LINKS.map((link) => (
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
