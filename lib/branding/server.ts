/**
 * The effective branding for pages (root layout: logos through BrandingProvider, favicon through generateMetadata).
 * Cached with unstable_cache under the storefront `settings` tag (the same tag as getStoreSettings), so an upload or
 * removal (revalidateTag in lib/branding/store.ts) reaches dynamic pages at once and static/ISR pages on their next
 * request. Never throws: without a database (build, outage) every slot is the built-in look. Server-only.
 */
import "server-only";
import { unstable_cache } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { STOREFRONT_REVALIDATE_SECONDS, STOREFRONT_TAGS } from "@/lib/storefront/data";
import { BUILT_IN_BRANDING, effectiveBranding, type EffectiveBranding } from "./model";
import { loadBrandingState } from "./store";

const cachedState = unstable_cache(() => loadBrandingState(db), ["branding", "state"], {
  tags: [STOREFRONT_TAGS.settings],
  revalidate: STOREFRONT_REVALIDATE_SECONDS,
});

/** Uploaded logos and favicon as versioned /brand URLs; null per slot = the built-in look. */
export const getBranding = cache(async (): Promise<EffectiveBranding> => {
  // Fixture mode (dev and tests without a database) shows the built-in look.
  if (getEnv().CATALOG_SOURCE === "fixtures") return BUILT_IN_BRANDING;
  try {
    return effectiveBranding(await cachedState());
  } catch (error) {
    unstable_rethrow(error);
    log.warn("branding_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return BUILT_IN_BRANDING;
  }
});
