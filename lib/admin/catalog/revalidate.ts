/**
 * Storefront cache invalidation after catalog writes (decisions.md Phase 2/6): every category, product, plan or release
 * change calls revalidateCatalog() after its transaction commits, so the cached storefront pages (unstable_cache with
 * STOREFRONT_TAGS, 300 s ISR) pick the change up on the next request instead of after the revalidate window.
 * A failed revalidation never fails the admin request (the change is committed; pages refresh within 300 s anyway).
 */
import "server-only";
import { revalidateTag } from "next/cache";
import { log } from "@/lib/log";
import { STOREFRONT_TAGS } from "@/lib/storefront/data";

export type StorefrontTag = (typeof STOREFRONT_TAGS)[keyof typeof STOREFRONT_TAGS];

export function revalidateStorefront(tags: readonly StorefrontTag[] = [STOREFRONT_TAGS.catalog]): void {
  for (const tag of new Set(tags)) {
    try {
      revalidateTag(tag);
    } catch (error) {
      log.warn("storefront_revalidate_failed", { tag, error });
    }
  }
}

/** The catalog tag (categories, products, plans, releases). */
export function revalidateCatalog(): void {
  revalidateStorefront([STOREFRONT_TAGS.catalog]);
}
