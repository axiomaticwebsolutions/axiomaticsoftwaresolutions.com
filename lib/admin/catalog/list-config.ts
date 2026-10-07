/**
 * URL list state of the catalog tables (admin bracket style: ?q=&filter[category]=&sort=-price&page=2), shared by the
 * server pages (parseListState) and the client tables (useListState), plus the conversion to the service query the
 * /api/admin list routes also build (with parseListQuery). Pure and client-safe.
 */
import { defineListState, type ListState } from "@/lib/url-state";
import { PLAN_TYPE_FILTERS, RELEASE_STATUS_FILTERS } from "./model";

/** Rows per page in the console tables (prototype: 10). The API defaults to 25. */
export const CATALOG_PAGE_SIZE = 10;

export const PRODUCT_STATUS_FILTERS = ["published", "hidden", "draft"] as const;
export const PRODUCT_SORTS = ["name", "latest", "price", "rank"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export const PRODUCT_DEFAULT_SORT = { id: "rank", desc: false } as const satisfies { id: ProductSort; desc: boolean };

export const PLAN_STATUS_FILTERS = ["on_sale", "archived"] as const;
export const PLAN_SORTS = ["name", "product", "price"] as const;
export type PlanSort = (typeof PLAN_SORTS)[number];
/** Plans grouped by product (product rank, then the plan's sort order). */
export const PLAN_DEFAULT_SORT = { id: "product", desc: false } as const satisfies { id: PlanSort; desc: boolean };

export const RELEASE_SORTS = ["date", "release"] as const;
export type ReleaseSort = (typeof RELEASE_SORTS)[number];
/** Newest first; drafts (no release date yet) on top. */
export const RELEASE_DEFAULT_SORT = { id: "date", desc: true } as const satisfies { id: ReleaseSort; desc: boolean };

export const PRODUCTS_LIST = defineListState<"category" | "status">({
  filterStyle: "bracket",
  filters: { category: {}, status: { values: PRODUCT_STATUS_FILTERS } },
  sortable: PRODUCT_SORTS,
  defaultSort: PRODUCT_DEFAULT_SORT,
  pageSize: CATALOG_PAGE_SIZE,
});

export const PLANS_LIST = defineListState<"product" | "type" | "status">({
  filterStyle: "bracket",
  filters: { product: {}, type: { values: PLAN_TYPE_FILTERS }, status: { values: PLAN_STATUS_FILTERS } },
  sortable: PLAN_SORTS,
  defaultSort: PLAN_DEFAULT_SORT,
  pageSize: CATALOG_PAGE_SIZE,
});

export const RELEASES_LIST = defineListState<"product" | "status">({
  filterStyle: "bracket",
  filters: { product: {}, status: { values: RELEASE_STATUS_FILTERS } },
  sortable: RELEASE_SORTS,
  defaultSort: RELEASE_DEFAULT_SORT,
  pageSize: CATALOG_PAGE_SIZE,
});

/** What the catalog list services take: the API's parseListQuery result or a page's parsed URL state. */
export type CatalogListQuery<F extends string, S extends string> = {
  q: string;
  filters: Partial<Record<F, string>>;
  sort: { id: S; desc: boolean };
  page: number;
  pageSize: number;
};

/** A page's URL state as a service query ("all" filters dropped, sort defaulted). */
export function catalogQueryFromState<F extends string, S extends string>(
  state: ListState<F>,
  sorts: readonly S[],
  fallback: { id: S; desc: boolean },
): CatalogListQuery<F, S> {
  const filters: Partial<Record<F, string>> = {};
  for (const [key, value] of Object.entries(state.filters) as [F, string][]) {
    if (value && value !== "all") filters[key] = value;
  }
  const sort = state.sort && (sorts as readonly string[]).includes(state.sort.id) ? { id: state.sort.id as S, desc: state.sort.desc } : fallback;
  return { q: state.q, filters, sort, page: state.page, pageSize: state.pageSize };
}
