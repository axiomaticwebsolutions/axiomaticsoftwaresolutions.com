/**
 * Price display preference: excluding or including GST (docs/decisions.md > Phase 2 storefront decisions).
 *
 * Every price renders both variants (components/store/price.tsx) and `<html data-price="excl|incl">` shows one
 * with CSS (app/globals.css), so pages stay static and never flash. The root layout renders the site default
 * (`priceModeFromSetting(settings.tax.priceDisplay)`); PRICE_DISPLAY_SCRIPT, inlined in <head>, applies the
 * visitor's choice from the `axs_price_incl` cookie ("1" incl, "0" excl) before first paint. The toggle writes
 * the cookie, updates the attribute and fires PRICE_MODE_EVENT so every toggle on the page stays in sync.
 *
 * Client-safe. The functions below that touch `document` or `window` must only run in the browser.
 */

export type PriceMode = "excl" | "incl";

export const PRICE_COOKIE = "axs_price_incl";
export const PRICE_ATTRIBUTE = "data-price";
export const PRICE_MODE_EVENT = "axs:price-mode";
/** One year. */
export const PRICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** The site default from SiteSetting tax.priceDisplay. */
export function priceModeFromSetting(priceDisplay: "exclusive" | "inclusive"): PriceMode {
  return priceDisplay === "inclusive" ? "incl" : "excl";
}

/** Cookie value -> mode; null when the visitor has not chosen (or the value is not ours). */
export function priceModeFromCookie(value: string | null | undefined): PriceMode | null {
  if (value === "1") return "incl";
  if (value === "0") return "excl";
  return null;
}

/**
 * Inline <head> script (ES5, no dependencies): copies the cookie choice onto <html data-price> before paint.
 * Exported as a constant so a CSP hash ('sha256-...') can be computed from it.
 */
export const PRICE_DISPLAY_SCRIPT =
  "(function(){try{var n=" +
  JSON.stringify(`${PRICE_COOKIE}=`) +
  ',c=document.cookie.split(";");for(var i=0;i<c.length;i++){var p=c[i].replace(/^ +/,"");if(p.indexOf(n)===0){var v=p.slice(n.length);if(v==="1"||v==="0")document.documentElement.setAttribute(' +
  JSON.stringify(PRICE_ATTRIBUTE) +
  ',v==="1"?"incl":"excl");break}}}catch(e){}})();';

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}

/** The mode currently shown (browser only). */
export function readPriceMode(): PriceMode {
  return document.documentElement.getAttribute(PRICE_ATTRIBUTE) === "incl" ? "incl" : "excl";
}

function applyPriceMode(mode: PriceMode): void {
  if (readPriceMode() === mode && document.documentElement.hasAttribute(PRICE_ATTRIBUTE)) return;
  document.documentElement.setAttribute(PRICE_ATTRIBUTE, mode);
  window.dispatchEvent(new CustomEvent<PriceMode>(PRICE_MODE_EVENT, { detail: mode }));
}

/** Saves the visitor's choice (cookie, one year) and switches every price on the page (browser only). */
export function setPriceMode(mode: PriceMode): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${PRICE_COOKIE}=${mode === "incl" ? "1" : "0"}; Path=/; Max-Age=${PRICE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  applyPriceMode(mode);
}

/** Re-applies the cookie (a choice made in another tab, or a page restored from the back/forward cache). */
function syncFromCookie(): void {
  const mode = priceModeFromCookie(readCookie(PRICE_COOKIE));
  if (mode) applyPriceMode(mode);
}

function onVisibility(): void {
  if (document.visibilityState === "visible") syncFromCookie();
}

/** useSyncExternalStore subscription (browser only). */
export function subscribePriceMode(listener: () => void): () => void {
  window.addEventListener(PRICE_MODE_EVENT, listener);
  window.addEventListener("pageshow", syncFromCookie);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener(PRICE_MODE_EVENT, listener);
    window.removeEventListener("pageshow", syncFromCookie);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
