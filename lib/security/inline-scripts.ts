/**
 * The inline <script> elements the app renders itself, and their CSP hash sources.
 *
 * Both run in the root layout's <head> on every page, static and dynamic. The root layout cannot read the per-request
 * nonce without making every storefront page dynamic, so the strict policy (lib/security/csp.ts) allows these exact
 * scripts by SHA-256 instead, which is as strong as a nonce for fixed text. Therefore each script must be a constant:
 * per-page data goes into attributes of the <script> element, never into its text.
 *
 * - PRICE_DISPLAY_SCRIPT (lib/storefront/price-display.ts): applies the visitor's GST display choice before paint.
 * - BANNER_SCRIPT (below; rendered by components/store/site-banner.tsx with the text in `data-banner-text`): hides an
 *   announcement the visitor already dismissed in this session, and handles the dismiss button.
 *
 * JSON-LD (`<script type="application/ld+json">`) is a data block, which CSP does not govern, so it needs neither.
 * Adding another inline script means adding it to INLINE_SCRIPTS, or the strict pages will block it.
 *
 * Pure and edge-safe: middleware.ts hashes these once per server process (synchronous SHA-256, lib/security/sha256.ts).
 */
import { PRICE_DISPLAY_SCRIPT } from "../storefront/price-display";
import { sha256 } from "./sha256";

/** sessionStorage key holding the text of the banner the visitor dismissed. */
export const BANNER_DISMISSED_KEY = "axiomatic.bannerDismissed";

/** Attribute of the banner's <script> element that carries the banner text (read through document.currentScript). */
export const BANNER_TEXT_ATTRIBUTE = "data-banner-text";

/**
 * ES5, no dependencies. Dismissing stores the banner text, so a new announcement shows again. Event delegation, so the
 * banner itself ships no JavaScript.
 */
export const BANNER_SCRIPT =
  "(function(){var d=document,r=d.documentElement,s=d.currentScript,k=" +
  JSON.stringify(BANNER_DISMISSED_KEY) +
  ",t=s&&s.getAttribute(" +
  JSON.stringify(BANNER_TEXT_ATTRIBUTE) +
  ");if(t==null)return;" +
  'try{if(sessionStorage.getItem(k)===t)r.setAttribute("data-banner-dismissed","")}catch(e){}' +
  'd.addEventListener("click",function(e){var b=e.target&&e.target.closest&&e.target.closest("[data-banner-dismiss]");' +
  "if(!b)return;try{sessionStorage.setItem(k,t)}catch(x){}" +
  'r.setAttribute("data-banner-dismissed","");var m=d.getElementById("main");if(m)m.focus({preventScroll:true})})})();';

/** Every inline script the app renders (text exactly as rendered). */
export const INLINE_SCRIPTS: readonly string[] = [PRICE_DISPLAY_SCRIPT, BANNER_SCRIPT];

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** `'sha256-<base64>'` of a script's UTF-8 text (the form CSP compares against the element's text). */
export function sha256Source(script: string): string {
  return `'sha256-${base64(sha256(new TextEncoder().encode(script)))}'`;
}

let cached: readonly string[] | null = null;

/** Hash sources of INLINE_SCRIPTS, computed once per process. */
export function inlineScriptHashSources(): readonly string[] {
  cached ??= INLINE_SCRIPTS.map(sha256Source);
  return cached;
}
