"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { HEADER_LINKS, activeNavFor, ariaCurrentFor, type NavComingSoonGroup, type NavProduct } from "@/components/store/active-nav";
import { MegaMenu, navItemClassName } from "@/components/store/mega-menu";

export type HeaderNavProps = {
  products: readonly NavProduct[];
  /** COMING_SOON products by category (the Software menu's "Coming soon" directory). */
  comingSoon?: readonly NavComingSoonGroup[];
};

/**
 * Primary navigation (960px and up): the Software menu, then Pricing, Resources and Support. The item for the current
 * section gets the lavender background and aria-current ("page" on its own page, "true" inside its section).
 */
export function HeaderNav({ products, comingSoon }: HeaderNavProps) {
  const pathname = usePathname() ?? "/";
  const active = activeNavFor(pathname);
  return (
    <nav aria-label="Primary" className="hidden items-center gap-1 text-[15px] font-semibold leading-[21px] nav:flex">
      <MegaMenu products={products} comingSoon={comingSoon} pathname={pathname} active={active === "software"} />
      {HEADER_LINKS.map((link) => (
        <Link
          key={link.key}
          href={link.href}
          aria-current={ariaCurrentFor(pathname, link.href, link.key)}
          className={navItemClassName(active === link.key)}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/** CSS variable with the sticky header height (strip + bar), for sticky offsets and scroll-margin on pages. */
export const STORE_HEADER_VAR = "--store-header-h";

/**
 * Keeps `--store-header-h` equal to the sticky header down to the bottom of the bar's padding box: strip + 72px. The
 * bar's 1px border hangs below, so sticky elements at this offset tuck under it (the prototype's top:108px). Measured
 * because the strip wraps to two lines on phones and its text is a setting. Written on the store shell
 * (`[data-store-shell]`, which carries the server default) and on <html>, so portalled UI (toasts, drawers) can read
 * it too. Renders nothing.
 */
export function HeaderHeightSync({ headerId = "site-header" }: { headerId?: string }) {
  React.useEffect(() => {
    const header = document.getElementById(headerId);
    if (!header) return;
    const shell = header.closest<HTMLElement>("[data-store-shell]");
    const root = document.documentElement;
    const bar = header.querySelector<HTMLElement>("[data-header-bar]");
    const apply = () => {
      const px = bar ? bar.offsetTop + bar.clientHeight : header.getBoundingClientRect().height;
      const height = `${Math.round(px)}px`;
      shell?.style.setProperty(STORE_HEADER_VAR, height);
      root.style.setProperty(STORE_HEADER_VAR, height);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => {
      observer.disconnect();
      root.style.removeProperty(STORE_HEADER_VAR);
    };
  }, [headerId]);
  return null;
}
