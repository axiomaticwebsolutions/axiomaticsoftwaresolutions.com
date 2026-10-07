/**
 * Pure view model for the About page: company detail rows from settings.business and the "What we build" tiles.
 * Client-safe (type-only imports of settings), unit-tested directly.
 */
import { toIconName } from "@/components/store/active-nav";
import type { IconName } from "@/components/icons/registry";
import { ABOUT_COMPANY } from "@/content/about";
import type { BusinessSettings } from "@/lib/config";
import type { Tone } from "@/lib/design/tokens";
import { productHref } from "@/lib/storefront/derive";
import type { StoreProduct } from "@/lib/storefront/types";

type CompanyBusiness = Pick<BusinessSettings, "legalName" | "gstin" | "city" | "state" | "hours" | "sample">;

/** Appends a mark such as "(sample)" unless the value already carries it ("… (placeholder)" in the defaults). */
export function withMark(value: string, mark: string | null): string {
  if (!mark || value.includes(mark)) return value;
  return `${value} ${mark}`;
}

export type CompanyDetailRow = { key: "legalName" | "gstin" | "office" | "hours"; term: string; value: string };

/**
 * "Company details" rows: registered name, GSTIN, office (city, state) and support hours. While the details are
 * placeholders (business.sample) the name and office are marked "(placeholder)" and the GSTIN "(sample)", as in the
 * prototype. Empty values are left out.
 */
export function companyDetailRows(business: CompanyBusiness): CompanyDetailRow[] {
  const { terms, sampleMark, placeholderMark } = ABOUT_COMPANY;
  const placeholder = business.sample ? placeholderMark : null;
  const office = [business.city, business.state].map((s) => s.trim()).filter(Boolean).join(", ");
  const rows: CompanyDetailRow[] = [
    { key: "legalName", term: terms.legalName, value: business.legalName.trim() ? withMark(business.legalName.trim(), placeholder) : "" },
    { key: "gstin", term: terms.gstin, value: business.gstin ? withMark(business.gstin, business.sample ? sampleMark : null) : "" },
    { key: "office", term: terms.office, value: office ? withMark(office, placeholder) : "" },
    { key: "hours", term: terms.hours, value: business.hours.trim() },
  ];
  return rows.filter((row) => row.value !== "");
}

export type AboutProductTile = {
  id: string;
  name: string;
  category: string;
  icon: IconName;
  tone: Tone;
  href: string;
};

/** "What we build" tiles, in the order given (rank). */
export function aboutProductTiles(
  products: readonly Pick<StoreProduct, "id" | "shortName" | "icon" | "tone" | "category">[],
): AboutProductTile[] {
  return products.map((p) => ({
    id: p.id,
    name: p.shortName,
    category: p.category.name,
    icon: toIconName(p.icon),
    tone: p.tone,
    href: productHref(p.id),
  }));
}
