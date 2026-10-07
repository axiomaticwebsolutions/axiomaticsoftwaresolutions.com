/**
 * Product page view helpers (pure, client-safe): which sections render, labels, breadcrumbs, related products,
 * screenshot panels and the scroll-spy rule. Covered by tests/unit/product-page.test.ts.
 */
import { PRODUCT_SCREENSHOTS, type ProductScreenshot } from "@/content/screenshots";
import { formatDateIST } from "@/lib/dates";
import type { BreadcrumbItem } from "@/lib/seo/json-ld";
import {
  addOnPlans,
  categoryHref,
  latestRelease,
  mainPlans,
  productHref,
} from "@/lib/storefront/derive";
import type { StorePlan, StoreProduct, StoreRelease } from "@/lib/storefront/types";
import { PRODUCT_COPY, PRODUCT_SECTIONS, type ProductSectionId } from "./copy";

export type ProductNavSection = { id: ProductSectionId; label: string };

type SectionSource = Pick<StoreProduct, "content" | "plans" | "releases">;

/**
 * Sections that have something to show, in page order (also the in-page nav). Installation and Support always
 * render; the others are skipped when empty (no releases, no FAQs, ...), so the nav never links to a missing id.
 */
export function productSections(product: SectionSource, faqCount: number): ProductNavSection[] {
  const has: Record<ProductSectionId, boolean> = {
    features: product.content.features.length > 0,
    plans: mainPlans(product).length > 0 || addOnPlans(product).length > 0,
    requirements: product.content.requirements.length > 0,
    install: true,
    releases: product.releases.length > 0,
    support: true,
    faqs: faqCount > 0,
  };
  return PRODUCT_SECTIONS.filter((s) => has[s.id]).map((s) => ({ id: s.id, label: s.label }));
}

/** Hero chip: "15-day free trial". */
export function trialChipLabel(plan: Pick<StorePlan, "trialDays">): string {
  return `${plan.trialDays ?? 0}-day free trial`;
}

/** Add-to-cart toast detail: "Restaurant Billing · Monthly subscription × 3" (no "× 1"). */
export function cartToastDetail(shortName: string, planName: string, qty: number): string {
  return `${shortName} · ${planName}${qty > 1 ? ` × ${qty}` : ""}`;
}

/** Release date in IST: "15 Sep 2026". */
export function releaseDateLabel(release: Pick<StoreRelease, "releasedAt">): string {
  return formatDateIST(new Date(release.releasedAt));
}

/** Latest-release meta line: "Released 15 Sep 2026 · 148 MB" (the size is left out when unknown). */
export function releaseMetaLabel(release: Pick<StoreRelease, "releasedAt" | "sizeLabel">): string {
  const date = `Released ${releaseDateLabel(release)}`;
  return release.sizeLabel ? `${date} · ${release.sizeLabel}` : date;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(unit: string): string {
  return unit.endsWith("s") ? unit : `${unit}s`;
}

/** Stepper copy for per-unit plans: "Terminals", "Fewer terminals", "More terminals". */
export function perUnitCopy(perUnit: string): { label: string; fewer: string; more: string } {
  const units = plural(perUnit.trim().toLowerCase() || "unit");
  return { label: capitalize(units), fewer: `Fewer ${units}`, more: `More ${units}` };
}

/** Home / Software / {category} / {short name}: the visible trail and the BreadcrumbList JSON-LD. */
export function productBreadcrumbs(product: Pick<StoreProduct, "id" | "shortName" | "category">): BreadcrumbItem[] {
  return [
    { name: PRODUCT_COPY.breadcrumbHome, path: "/" },
    { name: PRODUCT_COPY.breadcrumbSoftware, path: "/software" },
    { name: product.category.name, path: categoryHref(product.category.id) },
    { name: product.shortName, path: productHref(product.id) },
  ];
}

/** Related products in the admin's order, skipping unknown ids and the product itself. */
export function relatedProducts<T extends Pick<StoreProduct, "id">>(
  product: Pick<StoreProduct, "id" | "relatedIds">,
  products: readonly T[],
): T[] {
  const out: T[] = [];
  for (const id of product.relatedIds) {
    if (id === product.id || out.some((p) => p.id === id)) continue;
    const found = products.find((p) => p.id === id);
    if (found) out.push(found);
  }
  return out;
}

/**
 * Screenshot panels for a product: the entries in content/screenshots.ts, or one generic "Overview" panel built from
 * the product's features (so a new product never renders an empty or broken hero).
 */
export function screenshotsFor(
  product: Pick<StoreProduct, "id" | "shortName" | "content" | "releases">,
): ProductScreenshot[] {
  const configured = PRODUCT_SCREENSHOTS[product.id];
  if (configured && configured.length > 0) return [...configured];
  const release = latestRelease(product);
  return [
    {
      tab: "Overview",
      title: "Overview",
      heading: product.shortName,
      rows: product.content.features.slice(0, 5).map((f) => ({ label: f.title, value: "Included" })),
      foot: release ? ["Version", release.version] : ["Status", "Ready"],
    },
  ];
}

export type SectionPosition = { id: string; top: number };

/**
 * Scroll-spy: the last section whose top has reached the line under the sticky header and in-page nav
 * (`threshold`, px from the viewport top), or null while the hero is still in view. `positions` are in page order.
 */
export function activeSectionId(positions: readonly SectionPosition[], threshold: number): string | null {
  let active: string | null = null;
  for (const p of positions) {
    if (p.top - threshold <= 1) active = p.id;
    else break;
  }
  return active;
}
