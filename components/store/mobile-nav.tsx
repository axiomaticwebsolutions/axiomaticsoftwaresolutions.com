"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { Logo } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { AccountMenu } from "@/components/store/account-menu";
import {
  BROWSE_ALL_SOFTWARE_LABEL,
  HEADER_LINKS,
  SEE_ALL_COMING_SOON_LABEL,
  SOFTWARE_MENU_SECTIONS,
  STORE_PATHS,
  TONE_TILE_CLASSES,
  ariaCurrentFor,
  comingSoonCategoryName,
  comingSoonLinkName,
  type NavComingSoonGroup,
  type NavProduct,
} from "@/components/store/active-nav";
import { CartButton } from "@/components/store/cart-button";
import { Container } from "@/components/store/container";
import { SampleNotice } from "@/components/store/sample-notice";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { COMING_SOON_CATALOG_HREF } from "@/lib/storefront/catalog-filter";
import { demoHref } from "@/lib/storefront/derive";
import { cn } from "@/lib/utils";

/** 42px outlined square that toggles the panel (menu / close icon). */
const TOGGLE_CLASS =
  "grid size-[42px] shrink-0 cursor-pointer place-items-center rounded-12 border border-line bg-surface text-ink transition-colors hover:border-line-input";

/** Rows in the panel; the current page gets a lavender background (aria-current carries it for assistive tech). */
const ROW_CLASS = "-mx-1 rounded-10 px-2 no-underline transition-colors [&[aria-current]]:bg-lavender-bg";

const NAV_BREAKPOINT = "(min-width: 60rem)";

/** Uppercase section label of the panel ("Available now", "Coming soon"). */
const LABEL_CLASS = "m-0 px-1 pb-1 pt-2.5 text-[11.5px] uppercase tracking-[0.12em] text-ink-2";

const NO_GROUPS: readonly NavComingSoonGroup[] = [];

type ComingSoonDirectoryProps = {
  groups: readonly NavComingSoonGroup[];
  pathname: string;
  onNavigate: () => void;
};

/**
 * "Coming soon" in the panel: one disclosure per category (a button with aria-expanded) listing its coming-soon
 * products, then "See all coming soon". The state lives here, inside the dialog content, so every opening of the panel
 * starts collapsed, except the category of the coming-soon product page being viewed (its link is the current page).
 */
function ComingSoonDirectory({ groups, pathname, onNavigate }: ComingSoonDirectoryProps) {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(groups.filter((g) => g.products.some((p) => ariaCurrentFor(pathname, p.href) === "page")).map((g) => g.id)),
  );
  const baseId = React.useId();
  const labelId = `${baseId}-label`;
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div role="group" aria-labelledby={labelId} className="grid gap-0.5">
      <p id={labelId} className={LABEL_CLASS}>
        {SOFTWARE_MENU_SECTIONS.comingSoon}
      </p>
      <ul className="m-0 grid list-none gap-0.5 p-0">
        {groups.map((group) => {
          const open = expanded.has(group.id);
          const listId = `${baseId}-${group.id}`;
          const count = group.products.length;
          return (
            <li key={group.id} className="grid">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                aria-label={comingSoonCategoryName(group.name, count)}
                onClick={() => toggle(group.id)}
                className="-mx-1 flex min-w-0 cursor-pointer items-center gap-3 rounded-10 border-0 bg-transparent px-2 py-2.5 text-left text-[15px] text-ink transition-colors hover:bg-lavender-soft aria-expanded:bg-lavender-soft"
              >
                {/* One line; wraps (up to two) only when the user's text spacing makes the name longer. */}
                <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]">{group.name}</span>
                <span aria-hidden="true" className="flex-none rounded-pill bg-slate-bg px-2 text-[12px] leading-[20px] text-ink-2">
                  {count}
                </span>
                <Icon
                  name="expand_more"
                  size={20}
                  className={cn("flex-none text-ink-2 transition-transform duration-200", open && "rotate-180")}
                />
              </button>
              <ul id={listId} hidden={!open} className="m-0 grid list-none gap-0.5 pb-1.5 pl-3 pt-0.5">
                {group.products.map((product) => (
                  <li key={product.slug} className="grid min-w-0">
                    <Link
                      href={product.href}
                      prefetch={false}
                      onClick={onNavigate}
                      aria-label={comingSoonLinkName(product.shortName)}
                      aria-current={ariaCurrentFor(pathname, product.href)}
                      className={cn(ROW_CLASS, "flex min-w-0 items-center gap-2.5 py-2 text-[14.5px] font-semibold text-ink-2")}
                    >
                      <span
                        aria-hidden="true"
                        className={cn("grid size-7 flex-none place-items-center rounded-8", TONE_TILE_CLASSES[product.tone])}
                      >
                        <Icon name={product.icon} size={16} />
                      </span>
                      <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{product.shortName}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      <Link
        href={COMING_SOON_CATALOG_HREF}
        onClick={onNavigate}
        className={cn(ROW_CLASS, "flex items-center gap-2 py-2.5 text-[14.5px] text-lavender-fg")}
      >
        <Icon name="schedule" size={18} />
        {/* One flex item, so the gap only separates the icon from the text (the arrow keeps a normal space). */}
        <span>
          {SEE_ALL_COMING_SOON_LABEL} <span aria-hidden="true">→</span>
        </span>
      </Link>
    </div>
  );
}

export type MobileNavProps = {
  products: readonly NavProduct[];
  /** COMING_SOON products by category: the "Coming soon" disclosures after the product list (none when empty). */
  comingSoon?: readonly NavComingSoonGroup[];
  /** Sample strip text when the strip shows, so the open panel lines up with the header it covers. */
  sampleNotice: string | null;
};

/**
 * Below 960px: the hamburger opens a full-width panel (Radix Dialog via Sheet: focus trap, Escape, scroll lock, focus
 * back on the hamburger). The panel repeats the strip and the bar on top, so the header looks unchanged except that
 * the hamburger has become a close button, then lists the products on sale ("Available now"), the coming-soon ones by
 * category ("Coming soon", one collapsed disclosure per category), Pricing, Resources, Support and the two CTAs.
 */
export function MobileNav({ products, comingSoon = NO_GROUPS, sampleNotice }: MobileNavProps) {
  const pathname = usePathname() ?? "/";
  const availableId = React.useId();
  // Keyed to the path it was opened on: following a link closes the panel.
  const [openAt, setOpenAt] = React.useState<string | null>(null);
  const open = openAt === pathname;
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const close = React.useCallback(() => setOpenAt(null), []);

  // The panel only exists below the nav breakpoint: close it when the window grows past it.
  React.useEffect(() => {
    if (!open) return;
    const query = window.matchMedia(NAV_BREAKPOINT);
    const onChange = () => {
      if (query.matches) setOpenAt(null);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={(next) => setOpenAt(next ? pathname : null)}>
      <SheetTrigger asChild>
        <button type="button" aria-label="Menu" className={cn(TOGGLE_CLASS, "nav:hidden")}>
          <Icon name="menu" size={23} />
        </button>
      </SheetTrigger>
      <SheetContent
        showClose={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
        className={cn(
          "inset-x-0 bottom-auto top-0 h-auto max-h-dvh max-w-none border-l-0 border-b border-line bg-bg shadow-menu nav:hidden",
          // A short drop instead of the drawer's slide from the right.
          "data-[state=open]:slide-in-from-right-0! data-[state=closed]:slide-out-to-right-0! data-[state=open]:slide-in-from-top-2",
        )}
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        {sampleNotice ? <SampleNotice text={sampleNotice} aria-hidden="true" /> : null}
        {/* Block wrapper: an auto-margin container would shrink to its content inside the flex column. */}
        <div className="shrink-0">
          <Container className="flex h-[72px] items-center gap-8">
            <Link
              href={STORE_PATHS.home}
              aria-label="Axiomatic Software Solutions — home"
              onClick={close}
              className="flex flex-none items-center rounded-10 text-ink no-underline"
            >
              <Logo className="gap-[11px]" />
            </Link>
            <div className="ml-auto flex items-center gap-2">
              <CartButton onClick={close} />
              <SheetClose asChild>
                <button ref={closeRef} type="button" aria-label="Close menu" className={TOGGLE_CLASS}>
                  <Icon name="close" size={23} />
                </button>
              </SheetClose>
            </div>
          </Container>
        </div>
        <nav
          aria-label="Mobile"
          // scroll-py-2: a link focused at the top or bottom edge keeps its 4px focus ring in view.
          className="grid min-h-0 scroll-py-2 content-start gap-0.5 overflow-y-auto overscroll-contain border-t border-line bg-surface px-5 pb-5 pt-3 font-bold leading-[1.35]"
        >
          {products.length > 0 ? (
            <div role="group" aria-labelledby={availableId} className="grid gap-0.5">
              <p id={availableId} className={LABEL_CLASS}>
                {SOFTWARE_MENU_SECTIONS.available}
              </p>
              <ul className="m-0 grid list-none gap-0.5 p-0">
                {products.map((product) => (
                  <li key={product.slug} className="grid">
                    <Link
                      href={product.href}
                      onClick={close}
                      aria-current={ariaCurrentFor(pathname, product.href)}
                      className={cn(ROW_CLASS, "flex items-center gap-3 py-2.5 text-ink")}
                    >
                      <span
                        aria-hidden="true"
                        className={cn("grid size-[34px] flex-none place-items-center rounded-10", TONE_TILE_CLASSES[product.tone])}
                      >
                        <Icon name={product.icon} size={20} />
                      </span>
                      {product.shortName}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {comingSoon.length > 0 ? <ComingSoonDirectory groups={comingSoon} pathname={pathname} onNavigate={close} /> : null}
          <Link
            href={STORE_PATHS.software}
            onClick={close}
            aria-current={ariaCurrentFor(pathname, STORE_PATHS.software)}
            className={cn(ROW_CLASS, "py-3 text-primary-link")}
          >
            {BROWSE_ALL_SOFTWARE_LABEL} <span aria-hidden="true">→</span>
          </Link>
          <hr className="my-1.5 h-px border-0 bg-line" />
          {HEADER_LINKS.map((link) => (
            <Link
              key={link.key}
              href={link.href}
              onClick={close}
              aria-current={ariaCurrentFor(pathname, link.href, link.key)}
              className={cn(ROW_CLASS, "py-3 text-ink")}
            >
              {link.label}
            </Link>
          ))}
          <div className="mt-2.5 grid grid-cols-2 gap-2.5">
            <AccountMenu variant="mobile" onNavigate={close} />
            <Link
              href={demoHref()}
              onClick={close}
              className="grid place-items-center rounded-12 bg-primary p-[13px] text-center text-white no-underline transition-colors hover:bg-primary-hover"
            >
              Request a demo
            </Link>
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
