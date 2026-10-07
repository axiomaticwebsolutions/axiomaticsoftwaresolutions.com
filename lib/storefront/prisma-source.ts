/**
 * CATALOG_SOURCE=db: reads the storefront view from PostgreSQL. Only PUBLISHED products, PUBLISHED stable-channel
 * releases (the channel customers can download; decisions.md Phase 4 "Release channel"), only
 * non-archived plans and published FAQs; DRAFT and HIDDEN products never leave this module. Rows are mapped to plain
 * JSON (ISO dates, BigInt sizes turned into "148 MB" labels) so lib/storefront/data.ts can cache them.
 */
import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { PublishStatus, ReleaseStatus } from "@/generated/prisma/enums";
import { productContentSchema, type ProductContent } from "@/lib/catalog/content";
import { getSettings } from "@/lib/config";
import type { Db } from "@/lib/db";
import { TONE_NAMES, type Tone } from "@/lib/design/tokens";
import { STABLE_CHANNEL } from "@/lib/licensing/entitlement";
import { log } from "@/lib/log";
import { PLATFORMS, formatFileSize } from "./derive";
import type { StoreCategory, StoreFaq, StorePlan, StoreProduct, StoreRelease, StoreSettings } from "./types";

const productInclude = {
  category: true,
  plans: { where: { archived: false }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
  releases: {
    where: { status: ReleaseStatus.PUBLISHED, channel: STABLE_CHANNEL },
    include: { files: { select: { platform: true, sizeBytes: true }, orderBy: { platform: "asc" } } },
  },
} satisfies Prisma.ProductInclude;

export type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
export type ReleaseRow = ProductRow["releases"][number];
export type PlanRow = ProductRow["plans"][number];
export type FaqRow = { id: string; question: string; answer: string; href: string | null };

const FALLBACK_TONE: Tone = "lavender";
const EMPTY_CONTENT: ProductContent = { features: [], benefits: [], requirements: [] };

function toTone(value: string | null | undefined): Tone | null {
  return value && (TONE_NAMES as readonly string[]).includes(value) ? (value as Tone) : null;
}

export function toStoreFaq(row: FaqRow): StoreFaq {
  return { id: row.id, question: row.question, answer: row.answer, href: row.href ?? null };
}

export function toStorePlan(row: PlanRow): StorePlan {
  return {
    id: row.id,
    productId: row.productId,
    type: row.type,
    name: row.name,
    summary: row.summary,
    includes: [...row.includes],
    pricePaise: row.pricePaise,
    interval: row.interval,
    trialDays: row.trialDays,
    deviceLimit: row.deviceLimit,
    perUnit: row.perUnit,
    maxQty: row.maxQty,
    multiDevice: row.multiDevice,
    updatesMonths: row.updatesMonths,
    popular: row.popular,
    sortOrder: row.sortOrder,
  };
}

/** The size label comes from the Windows installer when there is one, otherwise from the first file. */
export function toStoreRelease(row: ReleaseRow): StoreRelease {
  const sized = row.files.find((f) => f.platform === "windows") ?? row.files[0];
  return {
    version: row.version,
    releasedAt: (row.releasedAt ?? row.createdAt).toISOString(),
    notes: [...row.notes],
    sizeLabel: sized ? formatFileSize(sized.sizeBytes) : "",
    platforms: PLATFORMS.filter((p) => row.files.some((f) => f.platform === p)),
  };
}

/** `publishedIds` keeps related links pointing at PUBLISHED products only. */
export function toStoreProduct(row: ProductRow, faqs: StoreFaq[], publishedIds: ReadonlySet<string>): StoreProduct {
  const content = productContentSchema.safeParse(row.content);
  if (!content.success) {
    log.warn("product_content_invalid", {
      product: row.id,
      fields: content.error.issues.map((i) => i.path.join(".") || "(root)"),
    });
  }
  const categoryTone = toTone(row.category.tone) ?? FALLBACK_TONE;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shortName: row.shortName,
    tagline: row.tagline,
    summary: row.summary,
    icon: row.icon,
    tone: toTone(row.tone) ?? categoryTone,
    category: { id: row.category.id, name: row.category.name, tone: categoryTone, icon: row.category.icon },
    platforms: PLATFORMS.filter((p) => row.platforms.includes(p)),
    demoEnabled: row.demoEnabled,
    rank: row.rank,
    content: content.success ? content.data : EMPTY_CONTENT,
    relatedIds: [...new Set(row.relatedIds)].filter((id) => id !== row.id && publishedIds.has(id)),
    createdAt: row.createdAt.toISOString(),
    plans: row.plans.map(toStorePlan),
    releases: row.releases.map(toStoreRelease).sort((a, b) => b.releasedAt.localeCompare(a.releasedAt)),
    faqs,
  };
}

const faqSelect = { id: true, page: true, question: true, answer: true, href: true } as const;
const faqOrder = [{ sortOrder: "asc" }, { id: "asc" }] satisfies Prisma.FaqOrderByWithRelationInput[];

export async function loadStoreSettings(db: Db): Promise<StoreSettings> {
  return getSettings(db);
}

export async function loadStoreCategories(db: Db): Promise<StoreCategory[]> {
  const rows = await db.category.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { products: { where: { status: PublishStatus.PUBLISHED } } } } },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    tone: toTone(c.tone) ?? FALLBACK_TONE,
    icon: c.icon,
    sortOrder: c.sortOrder,
    productCount: c._count.products,
  }));
}

/** PUBLISHED products by rank (then name), each with its published FAQs. Two queries. */
export async function loadStoreProducts(db: Db): Promise<StoreProduct[]> {
  const rows = await db.product.findMany({
    where: { status: PublishStatus.PUBLISHED },
    orderBy: [{ rank: "asc" }, { name: "asc" }],
    include: productInclude,
  });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const faqRows = await db.faq.findMany({ where: { page: { in: ids }, published: true }, orderBy: faqOrder, select: faqSelect });
  const faqsByPage = new Map<string, StoreFaq[]>();
  for (const f of faqRows) {
    const list = faqsByPage.get(f.page) ?? [];
    list.push(toStoreFaq(f));
    faqsByPage.set(f.page, list);
  }
  const publishedIds = new Set(ids);
  return rows.map((r) => toStoreProduct(r, faqsByPage.get(r.id) ?? [], publishedIds));
}

export async function loadFaqs(db: Db, page: string): Promise<StoreFaq[]> {
  const rows = await db.faq.findMany({ where: { page, published: true }, orderBy: faqOrder, select: faqSelect });
  return rows.map(toStoreFaq);
}
