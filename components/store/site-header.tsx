import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { AccountMenu } from "@/components/store/account-menu";
import { STORE_PATHS, type NavComingSoonGroup, type NavProduct } from "@/components/store/active-nav";
import { CartButton } from "@/components/store/cart-button";
import { Container } from "@/components/store/container";
import { HeaderHeightSync, HeaderNav } from "@/components/store/header-nav";
import { MobileNav } from "@/components/store/mobile-nav";
import { SampleNotice } from "@/components/store/sample-notice";
import { Button } from "@/components/ui/button";
import { demoHref } from "@/lib/storefront/derive";

/** Bar height, and the strip's height on one line: 36 + 72 = the prototype's 108px sticky offset. */
export const STORE_BAR_HEIGHT = 72;
export const STORE_STRIP_HEIGHT = 36;

/**
 * Header height before the client measures it (pages read `var(--store-header-h)`): strip + bar, without the bar's 1px
 * bottom border, so sticky elements placed at this offset tuck under the border (the prototype's top:108px).
 */
export function defaultHeaderHeight(sampleNoticeShown: boolean): number {
  return sampleNoticeShown ? STORE_STRIP_HEIGHT + STORE_BAR_HEIGHT : STORE_BAR_HEIGHT;
}

export type SiteHeaderProps = {
  /** Published products by rank, for the Software menu and the mobile panel. */
  products: readonly NavProduct[];
  /** COMING_SOON products by category, for the "Coming soon" directory of both menus ([] = no section). */
  comingSoon?: readonly NavComingSoonGroup[];
  /** settings["content.sampleNotice"].text when enabled, else null. */
  sampleNotice: string | null;
};

/**
 * Sticky storefront header (README > Storefront header): the optional dark sample strip, then the 72px translucent
 * bar with the logo, the primary nav (960px and up), the cart, Sign in (or the account menu once the client knows a
 * session exists) and Request a demo, or the hamburger below 960px. Strip and bar stick together. Server component;
 * the interactive parts are client islands, so pages stay static.
 */
export function SiteHeader({ products, comingSoon, sampleNotice }: SiteHeaderProps) {
  return (
    <header id="site-header" className="sticky top-0 z-50">
      <HeaderHeightSync />
      {sampleNotice ? <SampleNotice text={sampleNotice} /> : null}
      <div data-header-bar="" className="border-b border-line bg-bg/90 backdrop-blur-[12px] backdrop-saturate-[1.4]">
        <Container className="flex h-[72px] items-center gap-8">
          <Link
            href={STORE_PATHS.home}
            aria-label="Axiomatic Software Solutions — home"
            className="flex flex-none items-center rounded-10 text-ink no-underline"
          >
            <Logo className="gap-[11px]" />
          </Link>
          <HeaderNav products={products} comingSoon={comingSoon} />
          <div className="ml-auto flex items-center gap-2">
            <CartButton />
            <div className="hidden items-center gap-2 nav:flex">
              <AccountMenu />
              <Button asChild className="leading-[21px]">
                <Link href={demoHref()}>Request a demo</Link>
              </Button>
            </div>
            <MobileNav products={products} comingSoon={comingSoon} sampleNotice={sampleNotice} />
          </div>
        </Container>
      </div>
    </header>
  );
}
