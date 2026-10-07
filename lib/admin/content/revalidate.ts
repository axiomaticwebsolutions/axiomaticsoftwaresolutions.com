/**
 * Storefront cache invalidation after admin content writes (decisions.md Phase 2: "Phase 6 admin writes must call
 * revalidateTag(STOREFRONT_TAGS.*)"). Called after the transaction commits. A failure only delays the change until the
 * cache's 300 s revalidation, so it is logged rather than turned into an error for a write that already succeeded.
 */
import "server-only";
import { revalidateTag } from "next/cache";
import { log } from "@/lib/log";
import { STOREFRONT_TAGS } from "@/lib/storefront/data";

export type StorefrontTag = keyof typeof STOREFRONT_TAGS;

export function revalidateStorefront(...tags: StorefrontTag[]): void {
  for (const tag of tags) {
    try {
      revalidateTag(STOREFRONT_TAGS[tag]);
    } catch (error) {
      log.warn("storefront_revalidate_failed", { tag, error: error instanceof Error ? error.name : typeof error });
    }
  }
}
