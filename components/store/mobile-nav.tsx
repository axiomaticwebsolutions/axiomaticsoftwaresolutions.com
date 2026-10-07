"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { Logo } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { AccountMenu } from "@/components/store/account-menu";
import { HEADER_LINKS, STORE_PATHS, TONE_TILE_CLASSES, ariaCurrentFor, type NavProduct } from "@/components/store/active-nav";
import { CartButton } from "@/components/store/cart-button";
import { Container } from "@/components/store/container";
import { SampleNotice } from "@/components/store/sample-notice";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { demoHref } from "@/lib/storefront/derive";
import { cn } from "@/lib/utils";

/** 42px outlined square that toggles the panel (menu / close icon). */
const TOGGLE_CLASS =
  "grid size-[42px] shrink-0 cursor-pointer place-items-center rounded-12 border border-line bg-surface text-ink transition-colors hover:border-line-input";

/** Rows in the panel; the current page gets a lavender background (aria-current carries it for assistive tech). */
const ROW_CLASS = "-mx-1 rounded-10 px-2 no-underline transition-colors [&[aria-current]]:bg-lavender-bg";

const NAV_BREAKPOINT = "(min-width: 60rem)";

export type MobileNavProps = {
  products: readonly NavProduct[];
  /** Sample strip text when the strip shows, so the open panel lines up with the header it covers. */
  sampleNotice: string | null;
};

/**
 * Below 960px: the hamburger opens a full-width panel (Radix Dialog via Sheet: focus trap, Escape, scroll lock, focus
 * back on the hamburger). The panel repeats the strip and the bar on top, so the header looks unchanged except that
 * the hamburger has become a close button, then lists every product, Pricing, Resources, Support and the two CTAs.
 */
export function MobileNav({ products, sampleNotice }: MobileNavProps) {
  const pathname = usePathname() ?? "/";
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
          className="grid min-h-0 content-start gap-0.5 overflow-y-auto overscroll-contain border-t border-line bg-surface px-5 pb-5 pt-3 font-bold leading-[1.35]"
        >
          <p className="m-0 px-1 pb-1 pt-2.5 text-[11.5px] uppercase tracking-[0.12em] text-ink-2">Software</p>
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
          <Link
            href={STORE_PATHS.software}
            onClick={close}
            aria-current={ariaCurrentFor(pathname, STORE_PATHS.software)}
            className={cn(ROW_CLASS, "py-3 text-primary-link")}
          >
            Browse all software <span aria-hidden="true">→</span>
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
