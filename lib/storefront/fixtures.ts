/**
 * CATALOG_SOURCE=fixtures: the storefront view built from the SAMPLE seed data (prisma/seed-data), so pages render
 * without PostgreSQL in development and tests. Mirrors what the seed writes and prisma-source.ts reads back (same
 * ids, order and labels; every sample product is PUBLISHED). Refused in production by lib/env.ts.
 * Every call returns fresh objects, so callers may not mutate shared state by accident.
 */
import "server-only";
import { startOfDayIST } from "@/lib/dates";
import {
  CATEGORIES,
  PLANS,
  PRODUCTS,
  parseSizeBytes,
  planSortOrder,
  type SeedFaq,
  type SeedPlan,
  type SeedProduct,
  type SeedRelease,
} from "@/prisma/seed-data/catalog";
import { HOME_FAQS, PRICING_FAQS, SEED_SETTINGS, SUPPORT_FAQS } from "@/prisma/seed-data/content";
import { seedIds } from "@/prisma/seed-data/ids";
import { PLATFORMS, formatFileSize, newestRelease } from "./derive";
import type {
  Platform,
  StoreCategory,
  StoreFaq,
  StoreLatestRelease,
  StorePlan,
  StoreProduct,
  StoreRelease,
  StoreSettings,
} from "./types";

const STATIC_FAQS: Readonly<Record<string, readonly SeedFaq[]>> = {
  home: HOME_FAQS,
  pricing: PRICING_FAQS,
  support: SUPPORT_FAQS,
};

function toFaqs(page: string, list: readonly SeedFaq[]): StoreFaq[] {
  return list.map((f, i) => ({ id: seedIds.faq(page, i + 1), question: f.question, answer: f.answer, href: f.href ?? null }));
}

function canonicalPlatforms(platforms: readonly Platform[]): Platform[] {
  return PLATFORMS.filter((p) => platforms.includes(p));
}

function toPlan(p: SeedPlan): StorePlan {
  return {
    id: p.id,
    productId: p.productId,
    type: p.type,
    name: p.name,
    summary: p.summary,
    includes: [...p.includes],
    pricePaise: p.pricePaise,
    interval: p.interval,
    trialDays: p.trialDays,
    deviceLimit: p.deviceLimit,
    perUnit: p.perUnit,
    maxQty: p.maxQty,
    multiDevice: p.multiDevice,
    updatesMonths: p.updatesMonths,
    popular: p.popular,
    sortOrder: planSortOrder(p.id),
  };
}

function toRelease(product: SeedProduct, r: SeedRelease): StoreRelease {
  return {
    version: r.version,
    releasedAt: startOfDayIST(r.date).toISOString(),
    notes: [...r.notes],
    // Same path as the database source: bytes (one size per release in the data file) -> label.
    sizeLabel: formatFileSize(parseSizeBytes(r.size)),
    platforms: canonicalPlatforms(product.platforms),
  };
}

function toProduct(p: SeedProduct): StoreProduct {
  const category = CATEGORIES.find((c) => c.id === p.categoryId);
  if (!category) throw new RangeError(`Unknown category ${p.categoryId}`);
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    shortName: p.shortName,
    tagline: p.tagline,
    summary: p.summary,
    icon: p.icon,
    tone: p.tone,
    category: { id: category.id, name: category.name, tone: category.tone, icon: category.icon },
    platforms: canonicalPlatforms(p.platforms),
    demoEnabled: p.demoEnabled,
    rank: p.rank,
    content: structuredClone(p.content),
    relatedIds: p.relatedIds.filter((id) => PRODUCTS.some((x) => x.id === id)),
    createdAt: startOfDayIST(p.added).toISOString(),
    plans: PLANS.filter((plan) => plan.productId === p.id)
      .map(toPlan)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    releases: p.releases.map((r) => toRelease(p, r)).sort((a, b) => b.releasedAt.localeCompare(a.releasedAt)),
    faqs: toFaqs(p.id, p.faqs),
  };
}

export function fixtureSettings(): StoreSettings {
  return structuredClone(SEED_SETTINGS);
}

export function fixtureCategories(): StoreCategory[] {
  return CATEGORIES.map((c, i) => ({
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    tone: c.tone,
    icon: c.icon,
    sortOrder: i,
    productCount: PRODUCTS.filter((p) => p.categoryId === c.id).length,
  }));
}

/** Every sample product (all PUBLISHED), by rank then name. */
export function fixtureProducts(): StoreProduct[] {
  return PRODUCTS.map(toProduct).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

export function fixtureProduct(slug: string): StoreProduct | null {
  const found = PRODUCTS.find((p) => p.id === slug);
  return found ? toProduct(found) : null;
}

/** FAQs for "home", "pricing", "support" or a product slug; [] for anything else. */
export function fixtureFaqs(page: string): StoreFaq[] {
  const list = Object.hasOwn(STATIC_FAQS, page) ? STATIC_FAQS[page] : PRODUCTS.find((p) => p.id === page)?.faqs;
  return list ? toFaqs(page, list) : [];
}

export function fixtureLatestRelease(): StoreLatestRelease | null {
  return newestRelease(fixtureProducts());
}
