/**
 * What each Product.status allows (decisions.md 2026-10-09 "Coming soon"). Pure and client-safe (string literals, no
 * runtime enum import), shared by the storefront, checkout, licensing and admin code.
 *
 * | status      | storefront listing            | new sales, trials | renewals, add-ons, downloads of existing licenses |
 * |-------------|-------------------------------|-------------------|---------------------------------------------------|
 * | PUBLISHED   | yes, with plans and prices    | yes               | yes                                               |
 * | COMING_SOON | yes, "Coming soon", no prices | no                | no (it has never been sold)                       |
 * | HIDDEN      | no                            | no                | yes (no longer sold to new customers)             |
 * | DRAFT       | no                            | no                | no                                                |
 */
export type ProductStatusValue = "DRAFT" | "PUBLISHED" | "HIDDEN" | "COMING_SOON";

/** Sold to new customers: plans, prices, cart, checkout, quotes and trials. */
export function isOnSale(status: string): boolean {
  return status === "PUBLISHED";
}

/** Shown on the storefront (catalog, product page, sitemap): PUBLISHED and COMING_SOON. */
export function isListed(status: string): boolean {
  return status === "PUBLISHED" || status === "COMING_SOON";
}

/** Existing licenses keep renewing, buying add-ons and downloading: PUBLISHED and HIDDEN (never DRAFT or COMING_SOON). */
export function servesExistingLicenses(status: string): boolean {
  return status === "PUBLISHED" || status === "HIDDEN";
}
