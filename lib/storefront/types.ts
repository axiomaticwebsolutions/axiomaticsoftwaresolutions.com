/**
 * Storefront view types. Client-safe (type-only imports). Every value is plain JSON: cached values round-trip through
 * JSON (unstable_cache), so dates are ISO strings and file sizes are pre-formatted labels.
 */
import type { BillingInterval, PlanType } from "@/generated/prisma/enums";
import type { ProductContent } from "@/lib/catalog/content";
import type { SiteSettings } from "@/lib/config";
import type { Tone } from "@/lib/design/tokens";

export type { BillingInterval, PlanType, ProductContent, Tone };

export type Platform = "windows" | "macos" | "android";

export type StoreCategory = {
  /** Slug, e.g. "pharmacy" (the catalog filter value). */
  id: string;
  name: string;
  blurb: string | null;
  tone: Tone;
  /** Material Symbols name. */
  icon: string;
  sortOrder: number;
  /** PUBLISHED products in the category. */
  productCount: number;
};

export type StorePlan = {
  id: string;
  productId: string;
  type: PlanType;
  name: string;
  summary: string | null;
  includes: string[];
  /** EXCLUDING GST. */
  pricePaise: number;
  interval: BillingInterval | null;
  trialDays: number | null;
  deviceLimit: number | null;
  /** "terminal" when the quantity is the device count. */
  perUnit: string | null;
  maxQty: number | null;
  multiDevice: boolean;
  updatesMonths: number | null;
  popular: boolean;
  sortOrder: number;
};

export type StoreRelease = {
  version: string;
  /** ISO date-time (start of the IST release day for seeded releases). */
  releasedAt: string;
  notes: string[];
  /** Installer size, e.g. "148 MB" (the Windows file first, else the first file). */
  sizeLabel: string;
  platforms: Platform[];
};

export type StoreFaq = {
  id: string;
  question: string;
  answer: string;
  /** Optional "Read the guide" link, e.g. "/docs/activate". */
  href: string | null;
};

export type StoreProductCategory = { id: string; name: string; tone: Tone; icon: string };

export type StoreProduct = {
  /** Slug, e.g. "medical-billing". */
  id: string;
  /** License key prefix, e.g. "MED". */
  code: string;
  name: string;
  shortName: string;
  tagline: string;
  summary: string;
  icon: string;
  /** Product tone, or the category tone when the product has no override. */
  tone: Tone;
  category: StoreProductCategory;
  platforms: Platform[];
  demoEnabled: boolean;
  rank: number;
  content: ProductContent;
  /** Related PUBLISHED products, in the order the admin chose. */
  relatedIds: string[];
  createdAt: string;
  /** Non-archived plans by sortOrder. */
  plans: StorePlan[];
  /** PUBLISHED releases, newest first. */
  releases: StoreRelease[];
  /** Published FAQs for the product page, by sortOrder. */
  faqs: StoreFaq[];
};

export type StoreSettings = SiteSettings;

export type StoreLatestRelease = {
  product: { id: string; name: string; shortName: string };
  release: StoreRelease;
};

/** Faq.page values the storefront reads, besides product slugs. */
export type StoreFaqPage = "home" | "pricing" | "support";
