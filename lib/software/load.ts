/**
 * Loads the "Software & downloads" view for one business account (server-only): the account's licenses (never
 * accountId = null rows), their products and the products' published releases with files. Three queries.
 */
import "server-only";
import type { TeamRole } from "@/generated/prisma/enums";
import type { Db } from "@/lib/db";
import { TONE_NAMES, type Tone } from "@/lib/design/tokens";
import { loadPublishedReleases } from "@/lib/downloads/releases";
import { teamCan } from "@/lib/rbac";
import { buildSoftwareView, type SoftwareView } from "./view";

const toTone = (value: string | null | undefined): Tone | null =>
  value && (TONE_NAMES as readonly string[]).includes(value) ? (value as Tone) : null;

export async function loadAccountSoftware(
  db: Db,
  opts: { accountId: string; role: TeamRole; now?: Date },
): Promise<SoftwareView> {
  const now = opts.now ?? new Date();
  const canDownload = teamCan(opts.role, "downloads");
  const licenses = await db.license.findMany({
    where: { accountId: opts.accountId },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      productId: true,
      status: true,
      expiresAt: true,
      updatesUntil: true,
      plan: { select: { name: true, type: true } },
    },
  });
  if (licenses.length === 0) return { products: [], canDownload };

  const productIds = [...new Set(licenses.map((l) => l.productId))];
  const [products, releases] = await Promise.all([
    db.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        name: true,
        shortName: true,
        icon: true,
        tone: true,
        rank: true,
        platforms: true,
        category: { select: { tone: true } },
      },
    }),
    loadPublishedReleases(db, productIds, now),
  ]);

  return buildSoftwareView({
    now,
    canDownload,
    licenses: licenses.map((l) => ({
      id: l.id,
      productId: l.productId,
      planName: l.plan.name,
      planType: l.plan.type,
      status: l.status,
      expiresAt: l.expiresAt,
      updatesUntil: l.updatesUntil,
    })),
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      shortName: p.shortName,
      icon: p.icon,
      tone: toTone(p.tone) ?? toTone(p.category.tone) ?? "lavender",
      rank: p.rank,
      platforms: p.platforms,
      releases: releases.get(p.id) ?? [],
    })),
  });
}
