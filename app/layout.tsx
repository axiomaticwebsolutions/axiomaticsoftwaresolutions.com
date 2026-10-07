import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Manrope } from "next/font/google";
import { unstable_rethrow } from "next/navigation";
import { PriceDisplayScript } from "@/components/store/price";
import { SiteBannerScript } from "@/components/store/site-banner";
import { SETTING_DEFAULTS, type SiteSettings } from "@/lib/config";
import { palette } from "@/lib/design/tokens";
import { log } from "@/lib/log";
import { SITE_LOCALE, SITE_NAME, siteOrigin } from "@/lib/seo/metadata";
import { getStoreSettings } from "@/lib/storefront/data";
import { priceModeFromSetting } from "@/lib/storefront/price-display";
import "./globals.css";

// latin-ext carries the rupee sign (U+20B9). The metric-matched fallback is declared in globals.css ("Manrope Metric
// Fallback", Manrope's characters only), so glyphs Manrope lacks (arrows) render in system-ui like the prototype.
const manrope = Manrope({
  subsets: ["latin", "latin-ext"],
  variable: "--font-manrope",
  display: "swap",
  adjustFontFallback: false,
  fallback: ['"Manrope Metric Fallback"', "system-ui", '"Segoe UI"', "sans-serif"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: {
    default: SITE_NAME,
    // Prototype titles: "Software — Axiomatic Software Solutions".
    template: `%s — ${SITE_NAME}`,
  },
  description: "Billing, GST and cheque printing software for Indian businesses.",
  applicationName: SITE_NAME,
  openGraph: { siteName: SITE_NAME, locale: SITE_LOCALE, type: "website" },
  twitter: { card: "summary_large_image" },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: palette.bg.DEFAULT,
  colorScheme: "light",
};

/** Settings for the price default and the banner script; the defaults keep every page up if the store is unreachable. */
async function rootSettings(): Promise<SiteSettings> {
  try {
    return await getStoreSettings();
  } catch (error) {
    unstable_rethrow(error);
    log.warn("root_layout_settings_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return structuredClone(SETTING_DEFAULTS) as SiteSettings;
  }
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const settings = await rootSettings();
  const banner = settings["content.banner"];
  return (
    // data-price is the site default; PriceDisplayScript applies the visitor's cookie before paint (hence the
    // hydration warning suppression, as with the banner's data-banner-dismissed).
    <html
      lang="en-IN"
      data-price={priceModeFromSetting(settings.tax.priceDisplay)}
      className={`${manrope.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <PriceDisplayScript />
        {banner.enabled && banner.text ? <SiteBannerScript text={banner.text} /> : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
