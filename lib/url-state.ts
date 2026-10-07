/**
 * List state in the URL: search (q), filters, sort and page for portal and admin tables.
 *
 *   /account/orders?q=AX-10&status=paid&sort=-date&page=2
 *   /admin/orders?filter[status]=paid&sort=-createdAt&page=1&pageSize=25   (filterStyle "bracket")
 *
 * Defaults are left out of the URL, unknown or invalid values fall back to the defaults (a hand-edited URL never
 * breaks a page), and changing the search, a filter, the sort or the page size goes back to page 1. Pure and
 * isomorphic: server pages parse `searchParams` with it, client tables write it (components/data-table/
 * use-list-state.ts), and API routes read the same shape.
 */

/** Sort by one column; serialised as "id" (ascending) or "-id" (descending), like the admin API contract. */
export type ListSort = { id: string; desc: boolean };

/** TanStack Table's sorting shape (structural, so this module needs no table import). */
export type SortingLike = ReadonlyArray<{ id: string; desc: boolean }>;

export type ListFilterDef = {
  /** Allowed values. Without a list, any short id-like value (letters, digits, _ - . :) is accepted. */
  values?: readonly string[];
  /** Value meaning "no filter" (default "all"); never written to the URL. */
  default?: string;
};

export type ListStateConfig<F extends string = string> = {
  filters?: { readonly [K in F]: ListFilterDef };
  /** Sortable column ids; a sort on any other id falls back to `defaultSort`. Omit to accept any id-like value. */
  sortable?: readonly string[];
  defaultSort?: ListSort | null;
  /** Default page size (10). */
  pageSize?: number;
  /** Page sizes a URL may ask for with ?pageSize=; without this list the page size is fixed. */
  pageSizes?: readonly number[];
  /** Longest search kept (default 100 characters). */
  maxQueryLength?: number;
  /** "plain": ?status=paid (portal, default); "bracket": ?filter[status]=paid (admin API contract). */
  filterStyle?: "plain" | "bracket";
  /** Parameter names (defaults q, sort, page, pageSize). */
  params?: Partial<Record<"q" | "sort" | "page" | "pageSize", string>>;
};

export type ListState<F extends string = string> = {
  q: string;
  filters: { [K in F]: string };
  sort: ListSort | null;
  page: number;
  pageSize: number;
};

export type ListStatePatch<F extends string = string> = Partial<Omit<ListState<F>, "filters">> & {
  filters?: Partial<{ [K in F]: string }>;
};

/** What Next.js passes as `searchParams`, a URLSearchParams, or anything with get(). */
export type SearchParamsInput =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export const DEFAULT_PAGE_SIZE = 10;
export const DEFAULT_MAX_QUERY_LENGTH = 100;
export const ALL = "all";
/** Highest page number accepted from a URL (protects OFFSET queries from absurd values). */
export const MAX_PAGE = 100_000;

const ID_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SORT_ID = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/** Identity helper that keeps the filter keys as a literal union: `const ORDERS = defineListState({...})`. */
export function defineListState<F extends string = never>(config: ListStateConfig<F>): ListStateConfig<F> {
  return config;
}

function paramName(config: ListStateConfig<string>, key: "q" | "sort" | "page" | "pageSize"): string {
  return config.params?.[key] ?? key;
}

function filterParam(config: ListStateConfig<string>, id: string): string {
  return config.filterStyle === "bracket" ? `filter[${id}]` : id;
}

function filterDefault(def: ListFilterDef | undefined): string {
  return def?.default ?? ALL;
}

/** First value of a parameter from any supported input. */
export function readParam(input: SearchParamsInput | null | undefined, name: string): string | undefined {
  if (!input) return undefined;
  if (typeof (input as { get?: unknown }).get === "function") {
    return (input as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const value = (input as Readonly<Record<string, string | readonly string[] | undefined>>)[name];
  if (typeof value === "string") return value;
  return value?.[0];
}

/** "-date" -> { id: "date", desc: true }; "date" -> ascending; anything malformed -> null. */
export function parseSort(raw: string | null | undefined): ListSort | null {
  if (!raw) return null;
  const desc = raw.startsWith("-");
  const id = desc ? raw.slice(1) : raw;
  return SORT_ID.test(id) ? { id, desc } : null;
}

export function formatSort(sort: ListSort): string {
  return sort.desc ? `-${sort.id}` : sort.id;
}

/** A positive page number, or 1. */
export function parsePage(raw: string | null | undefined): number {
  if (!raw || !/^\d{1,6}$/.test(raw)) return 1;
  const page = Number(raw);
  return page >= 1 && page <= MAX_PAGE ? page : 1;
}

/** Trims, collapses inner whitespace and caps the length of a search query. */
export function normalizeQuery(raw: string | null | undefined, maxLength = DEFAULT_MAX_QUERY_LENGTH): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
}

function sameSort(a: ListSort | null, b: ListSort | null): boolean {
  return a === b || (!!a && !!b && a.id === b.id && a.desc === b.desc);
}

function sortAllowed(config: ListStateConfig<string>, sort: ListSort | null): boolean {
  return !!sort && (!config.sortable || config.sortable.includes(sort.id));
}

function filterAllowed(def: ListFilterDef | undefined, value: string): boolean {
  if (value === filterDefault(def)) return true;
  return def?.values ? def.values.includes(value) : ID_LIKE.test(value);
}

/** The default state of a list (no search, default filters and sort, page 1). */
export function defaultListState<F extends string>(config: ListStateConfig<F>): ListState<F> {
  const filters = {} as { [K in F]: string };
  for (const id of Object.keys(config.filters ?? {}) as F[]) filters[id] = filterDefault(config.filters?.[id]);
  return {
    q: "",
    filters,
    sort: config.defaultSort ?? null,
    page: 1,
    pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
  };
}

/** Reads list state from search params; every invalid or unknown value falls back to its default. */
export function parseListState<F extends string>(
  input: SearchParamsInput | null | undefined,
  config: ListStateConfig<F>,
): ListState<F> {
  const state = defaultListState(config);
  state.q = normalizeQuery(readParam(input, paramName(config, "q")), config.maxQueryLength);

  for (const id of Object.keys(state.filters) as F[]) {
    const raw = readParam(input, filterParam(config, id));
    if (raw !== undefined && filterAllowed(config.filters?.[id], raw)) state.filters[id] = raw;
  }

  const sort = parseSort(readParam(input, paramName(config, "sort")));
  if (sortAllowed(config, sort)) state.sort = sort;

  const size = Number(readParam(input, paramName(config, "pageSize")));
  if (config.pageSizes?.includes(size)) state.pageSize = size;

  state.page = parsePage(readParam(input, paramName(config, "page")));
  return state;
}

/**
 * Writes list state into search params, leaving out defaults. Parameters that are not part of the list state
 * (for example ?tab=devices) are kept from `base`.
 */
export function listStateToParams<F extends string>(
  state: ListState<F>,
  config: ListStateConfig<F>,
  base?: SearchParamsInput | string | null,
): URLSearchParams {
  const params = toUrlSearchParams(base);
  const defaults = defaultListState(config);
  const set = (name: string, value: string | null) => {
    if (value === null) params.delete(name);
    else params.set(name, value);
  };

  const q = normalizeQuery(state.q, config.maxQueryLength);
  set(paramName(config, "q"), q ? q : null);
  for (const id of Object.keys(defaults.filters) as F[]) {
    const value = state.filters[id] ?? defaults.filters[id];
    set(filterParam(config, id), value === defaults.filters[id] ? null : value);
  }
  set(paramName(config, "sort"), state.sort && !sameSort(state.sort, defaults.sort) ? formatSort(state.sort) : null);
  set(paramName(config, "page"), state.page > 1 ? String(Math.min(Math.floor(state.page), MAX_PAGE)) : null);
  set(paramName(config, "pageSize"), state.pageSize !== defaults.pageSize ? String(state.pageSize) : null);
  return params;
}

function toUrlSearchParams(base: SearchParamsInput | string | null | undefined): URLSearchParams {
  if (!base) return new URLSearchParams();
  if (typeof base === "string") return new URLSearchParams(base);
  if (base instanceof URLSearchParams) return new URLSearchParams(base);
  // ReadonlyURLSearchParams (next/navigation) and other URLSearchParams-likes stringify to a query string.
  if (typeof (base as { get?: unknown }).get === "function") return new URLSearchParams(String(base));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(base as Readonly<Record<string, string | readonly string[] | undefined>>)) {
    if (typeof value === "string") params.append(key, value);
    else if (value) for (const item of value) params.append(key, item);
  }
  return params;
}

/** `pathname` plus the list state's query string (no "?" when everything is default). */
export function listStateHref<F extends string>(
  pathname: string,
  state: ListState<F>,
  config: ListStateConfig<F>,
  base?: SearchParamsInput | string | null,
): string {
  const query = listStateToParams(state, config, base).toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * Applies a change. A new search, filter, sort or page size goes back to page 1 unless the patch sets a page too;
 * filter patches merge into the current filters.
 */
export function updateListState<F extends string>(state: ListState<F>, patch: ListStatePatch<F>): ListState<F> {
  const next: ListState<F> = {
    q: patch.q ?? state.q,
    filters: patch.filters ? ({ ...state.filters, ...patch.filters } as ListState<F>["filters"]) : state.filters,
    sort: patch.sort === undefined ? state.sort : patch.sort,
    page: patch.page ?? state.page,
    pageSize: patch.pageSize ?? state.pageSize,
  };
  const reset =
    (patch.q !== undefined && normalizeQuery(patch.q) !== normalizeQuery(state.q)) ||
    (patch.filters !== undefined &&
      Object.entries(patch.filters).some(([id, value]) => value !== state.filters[id as F])) ||
    (patch.sort !== undefined && !sameSort(patch.sort, state.sort)) ||
    (patch.pageSize !== undefined && patch.pageSize !== state.pageSize);
  if (reset && patch.page === undefined) next.page = 1;
  return next;
}

/** True when a search or any non-default filter is active (sort and page do not count). */
export function isListFiltered<F extends string>(state: ListState<F>, config: ListStateConfig<F>): boolean {
  if (normalizeQuery(state.q)) return true;
  const defaults = defaultListState(config);
  return (Object.keys(defaults.filters) as F[]).some((id) => (state.filters[id] ?? defaults.filters[id]) !== defaults.filters[id]);
}

/** Clears the search and filters (keeps the sort and page size) and goes back to page 1. */
export function clearListFilters<F extends string>(state: ListState<F>, config: ListStateConfig<F>): ListState<F> {
  const defaults = defaultListState(config);
  return { ...state, q: "", filters: defaults.filters, page: 1 };
}

/** Same state? (q compared normalised; used to skip redundant URL writes.) */
export function sameListState<F extends string>(a: ListState<F>, b: ListState<F>): boolean {
  if (normalizeQuery(a.q) !== normalizeQuery(b.q) || a.page !== b.page || a.pageSize !== b.pageSize) return false;
  if (!sameSort(a.sort, b.sort)) return false;
  const keys = new Set([...Object.keys(a.filters), ...Object.keys(b.filters)]) as Set<F>;
  for (const key of keys) if (a.filters[key] !== b.filters[key]) return false;
  return true;
}

/** ListSort -> TanStack SortingState. */
export function toSortingState(sort: ListSort | null): { id: string; desc: boolean }[] {
  return sort ? [{ id: sort.id, desc: sort.desc }] : [];
}

/** TanStack SortingState -> ListSort (first column only; the tables sort by one column). */
export function fromSortingState(sorting: SortingLike): ListSort | null {
  const first = sorting[0];
  return first ? { id: first.id, desc: first.desc } : null;
}

/** Offset paging for a query: `{ skip, take }` (Prisma) for a page of `pageSize`. */
export function pageWindow(page: number, pageSize: number): { skip: number; take: number } {
  const size = Math.max(1, Math.floor(pageSize));
  const current = Math.min(Math.max(1, Math.floor(page)), MAX_PAGE);
  return { skip: (current - 1) * size, take: size };
}
