import type * as React from "react";
import { toNavProducts } from "@/components/store/active-nav";
import { SiteBanner } from "@/components/store/site-banner";
import { SiteFooter } from "@/components/store/site-footer";
import { SiteHeader, defaultHeaderHeight } from "@/components/store/site-header";
import { SkipLink } from "@/components/store/skip-link";
import { StoreToaster } from "@/components/store/store-toaster";
import { getComingSoonProducts, getStoreProducts, getStoreSettings } from "@/lib/storefront/data";

/**
 * Storefront shell: skip link, sticky header (sample strip + bar), optional announcement banner, <main id="main">,
 * footer and the store toaster. Data is fetched here (cached) and passed down as plain props.
 *
 * `--store-header-h` holds the sticky header height (108px with the one-line strip, 72px without; measured on the
 * client because the strip wraps on phones). Pages use it for sticky offsets, e.g. `top-[var(--store-header-h)]`.
 * Focus and anchor scrolling already clear the header: globals.css sets `scroll-padding-top` on <html> (header + 12px)
 * for store pages, so anchor targets only add a small scroll-margin of their own (e.g. `scroll-mt-2.5`).
 */
export default async function StoreLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [settings, products, comingSoon] = await Promise.all([getStoreSettings(), getStoreProducts(), getComingSoonProducts()]);
  const navProducts = toNavProducts(products);
  const notice = settings["content.sampleNotice"];
  const sampleNotice = notice.enabled && notice.text ? notice.text : null;
  const banner = settings["content.banner"];
  const shellStyle = { "--store-header-h": `${defaultHeaderHeight(sampleNotice !== null)}px` } as React.CSSProperties;

  return (
    <div data-store-shell="" style={shellStyle} className="flex min-h-dvh flex-col">
      <SkipLink />
      <SiteHeader products={navProducts} comingSoonCount={comingSoon.length} sampleNotice={sampleNotice} />
      {banner.enabled && banner.text ? <SiteBanner text={banner.text} /> : null}
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter products={navProducts} business={settings.business} />
      <StoreToaster />
    </div>
  );
}
