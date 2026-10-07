/**
 * Storefront prices. Server-compatible (no hooks): every price renders BOTH variants, `span.price-excl` and
 * `span.price-incl`, and `<html data-price>` shows one of them with CSS (app/globals.css), so static pages switch
 * instantly and never flash. Incl. GST amounts are exact paise: withTax(unit x qty), e.g. ₹5,898.82.
 * See lib/storefront/price-display.ts for the cookie, the default and the <head> script.
 */
import type * as React from "react";
import { DEFAULT_GST_RATE_PCT, formatINR, withTax } from "@/lib/money";
import { PRICE_DISPLAY_SCRIPT } from "@/lib/storefront/price-display";

// The toggle needs state and events, so it lives in a client module; import it from here.
export { PriceToggle, type PriceToggleProps } from "./price-toggle";

export type PriceVariantsProps = Omit<React.ComponentProps<"span">, "children"> & {
  /** Shown while prices exclude GST (the default). */
  excl: React.ReactNode;
  /** Shown while prices include GST. */
  incl: React.ReactNode;
};

/** Any copy that differs by price display, e.g. "+ 18% GST at checkout" vs "Includes 18% GST". */
export function PriceVariants({ excl, incl, ...props }: PriceVariantsProps) {
  return (
    <span data-slot="price-variants" {...props}>
      <span className="price-excl">{excl}</span>
      <span className="price-incl">{incl}</span>
    </span>
  );
}

export type PriceProps = Omit<React.ComponentProps<"span">, "children"> & {
  /** Unit price in paise, EXCLUDING GST. */
  paise: number;
  /** Quantity (per-terminal plans); the price shown is unit x qty. */
  qty?: number;
  /** Always show two decimals ("₹4,999.00"). */
  exact?: boolean;
  /** GST rate for the incl. variant (settings tax.gstRatePct). */
  ratePct?: number;
};

/** "₹4,999" excluding GST, "₹5,898.82" including it. */
export function Price({ paise, qty = 1, exact = false, ratePct = DEFAULT_GST_RATE_PCT, ...props }: PriceProps) {
  const excl = paise * qty;
  return (
    <PriceVariants
      data-slot="price"
      excl={formatINR(excl, { exact })}
      incl={formatINR(withTax(excl, ratePct), { exact })}
      {...props}
    />
  );
}

export type TaxNoteProps = Omit<React.ComponentProps<"span">, "children"> & {
  /** Default "+ GST". */
  excl?: React.ReactNode;
  /** Default "incl. GST". */
  incl?: React.ReactNode;
};

/** The note after a price: "+ GST" or "incl. GST" (pass other copy for longer notes). */
export function TaxNote({ excl = "+ GST", incl = "incl. GST", ...props }: TaxNoteProps) {
  return <PriceVariants data-slot="tax-note" excl={excl} incl={incl} {...props} />;
}

/**
 * Inline <head> script that applies the visitor's choice before first paint. Render it once in the root layout,
 * with `<html data-price={priceModeFromSetting(settings.tax.priceDisplay)} suppressHydrationWarning>`.
 */
export function PriceDisplayScript() {
  return <script id="axs-price-display" dangerouslySetInnerHTML={{ __html: PRICE_DISPLAY_SCRIPT }} />;
}
