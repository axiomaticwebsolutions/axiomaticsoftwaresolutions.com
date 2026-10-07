/**
 * Published releases and their installers for a set of products (server-only). Only PUBLISHED releases of the stable
 * channel whose release date has passed are returned, the same set /validate offers as latestEligibleVersion
 * (decisions.md Phase 4 fix pass "Release channel and order"); storage keys never leave this module.
 */
import "server-only";
import { ReleaseStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { STABLE_CHANNEL } from "@/lib/licensing/entitlement";
import {
  compareReleasesNewestFirst,
  sortDownloadFiles,
  toDownloadFile,
  type DownloadFileView,
  type DownloadReleaseView,
} from "./model";

export type PublishedRelease = {
  id: string;
  productId: string;
  version: string;
  releasedAt: Date;
  notes: string[];
  files: DownloadFileView[];
};

/** Upper bound of releases (with notes and files) returned per product: years of releases. */
export const MAX_RELEASES_PER_PRODUCT = 100;
/**
 * Release headers (id, version, dates: a few dozen bytes each) read per product to find the newest by version. The
 * SQL reads at most this many per product, most recent release date first, so the query stays bounded however long
 * the release history grows; notes and files are then loaded for the chosen releases only.
 */
export const RELEASE_SCAN_PER_PRODUCT = 500;

/** The releases customers may see: published, stable channel, release date reached. */
export function customerReleaseWhere(productId: string, now: Date): Prisma.ReleaseWhereInput {
  return { productId, status: ReleaseStatus.PUBLISHED, channel: STABLE_CHANNEL, releasedAt: { lte: now } };
}

/**
 * productId -> published stable releases, newest first (highest version; compareReleasesNewestFirst), at most
 * `perProduct` each, with their files (Windows, macOS, Android). Two bounded steps: one header query per product
 * (index Release_productId_status_idx, LIMIT RELEASE_SCAN_PER_PRODUCT), then one query for the chosen releases.
 */
export async function loadPublishedReleases(
  db: Db,
  productIds: readonly string[],
  now: Date,
  perProduct: number = MAX_RELEASES_PER_PRODUCT,
): Promise<Map<string, PublishedRelease[]>> {
  const byProduct = new Map<string, PublishedRelease[]>();
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return byProduct;
  const limit = Math.max(1, Math.floor(perProduct));

  const chosen: string[] = [];
  for (const productId of ids) {
    const heads = await db.release.findMany({
      where: customerReleaseWhere(productId, now),
      orderBy: [{ releasedAt: "desc" }, { createdAt: "desc" }],
      take: RELEASE_SCAN_PER_PRODUCT,
      select: { id: true, version: true, releasedAt: true },
    });
    const newest = heads.filter((h) => h.releasedAt !== null).sort(compareReleasesNewestFirst).slice(0, limit);
    for (const head of newest) chosen.push(head.id);
  }
  if (chosen.length === 0) return byProduct;

  const rows = await db.release.findMany({
    where: { id: { in: chosen } },
    select: {
      id: true,
      productId: true,
      version: true,
      releasedAt: true,
      notes: true,
      files: { select: { id: true, platform: true, fileName: true, sizeBytes: true } },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  // `chosen` is already in display order per product.
  for (const id of chosen) {
    const row = byId.get(id);
    if (!row?.releasedAt) continue;
    const list = byProduct.get(row.productId) ?? [];
    list.push({
      id: row.id,
      productId: row.productId,
      version: row.version,
      releasedAt: row.releasedAt,
      notes: [...row.notes],
      files: sortDownloadFiles(row.files.map(toDownloadFile)),
    });
    byProduct.set(row.productId, list);
  }
  return byProduct;
}

export function toDownloadReleaseView(release: PublishedRelease): DownloadReleaseView {
  return { id: release.id, version: release.version, releasedAt: release.releasedAt.toISOString(), files: release.files };
}
