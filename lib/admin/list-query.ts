/**
 * Admin list endpoints (decisions.md Phase 6, api-contracts section 7):
 *
 *   GET /api/admin/<resource>?q=&filter[status]=paid&sort=-createdAt&page=1&pageSize=25 -> { items, total, page, pageSize }
 *
 * Parsing is lenient like the pages' URL state (lib/url-state.ts): an unknown filter value, sort column or page falls
 * back to its default instead of failing, so a stale bookmark or hand-edited URL still lists something. pageSize is
 * capped at 100. Pure and isomorphic.
 */
import { DEFAULT_MAX_QUERY_LENGTH, MAX_PAGE, normalizeQuery, parsePage, parseSort } from "@/lib/url-state";

export const ADMIN_DEFAULT_PAGE_SIZE = 25;
export const ADMIN_MAX_PAGE_SIZE = 100;

/** Allowed values, or a parser returning the typed value (undefined/null = ignore the parameter). */
export type ListFilterSpec = readonly string[] | ((raw: string) => unknown);

export type ListQuerySpec<F extends Record<string, ListFilterSpec>, S extends string> = {
  /** Accept `q` (default true). */
  searchable?: boolean;
  filters?: F;
  sortable: readonly S[];
  /** "-createdAt", "name" or { id, desc }. */
  defaultSort: `${S}` | `-${S}` | { id: S; desc: boolean };
  /** Default 25. */
  defaultPageSize?: number;
  /** Longest search kept (default 100). */
  maxQueryLength?: number;
};

export type FilterValue<D> = D extends readonly (infer V)[] ? V : D extends (raw: string) => infer R ? NonNullable<R> : never;

export type ListQuery<F extends Record<string, ListFilterSpec>, S extends string> = {
  /** Normalised search ("" when none). */
  q: string;
  /** Only filters that were present and valid; "all" and "" mean no filter. */
  filters: { [K in keyof F]?: FilterValue<F[K]> };
  sort: { id: S; desc: boolean };
  page: number;
  pageSize: number;
  /** Prisma paging for this page. */
  skip: number;
  take: number;
};

export type ListQueryInput = Request | URL | URLSearchParams | string;

function searchParamsOf(input: ListQueryInput): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (input instanceof URL) return input.searchParams;
  if (typeof input === "string") {
    const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input.startsWith("/") || input.includes("://") ? "" : input;
    return new URLSearchParams(query);
  }
  return new URL(input.url).searchParams;
}

function resolveDefaultSort<S extends string>(spec: ListQuerySpec<Record<string, ListFilterSpec>, S>["defaultSort"]): { id: S; desc: boolean } {
  if (typeof spec !== "string") return spec;
  const parsed = parseSort(spec);
  if (!parsed) throw new RangeError(`Invalid default sort "${spec}"`);
  return parsed as { id: S; desc: boolean };
}

/** Parses the list query of an admin list or export request. */
export function parseListQuery<F extends Record<string, ListFilterSpec> = Record<never, ListFilterSpec>, S extends string = string>(
  input: ListQueryInput,
  spec: ListQuerySpec<F, S>,
): ListQuery<F, S> {
  const params = searchParamsOf(input);
  const q = spec.searchable === false ? "" : normalizeQuery(params.get("q"), spec.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH);

  const filters: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(spec.filters ?? {}) as [string, ListFilterSpec][]) {
    const raw = (params.get(`filter[${key}]`) ?? "").trim();
    if (raw === "" || raw === "all" || raw.length > 200) continue;
    if (typeof def === "function") {
      const value = def(raw);
      if (value !== undefined && value !== null) filters[key] = value;
    } else if (def.includes(raw)) {
      filters[key] = raw;
    }
  }

  const fallback = resolveDefaultSort(spec.defaultSort);
  const requested = parseSort(params.get("sort"));
  const sort = requested && (spec.sortable as readonly string[]).includes(requested.id) ? (requested as { id: S; desc: boolean }) : fallback;

  const defaultSize = Math.min(spec.defaultPageSize ?? ADMIN_DEFAULT_PAGE_SIZE, ADMIN_MAX_PAGE_SIZE);
  const rawSize = params.get("pageSize");
  const size = rawSize && /^\d{1,4}$/.test(rawSize) ? Number(rawSize) : NaN;
  const pageSize = Number.isInteger(size) && size >= 1 ? Math.min(size, ADMIN_MAX_PAGE_SIZE) : defaultSize;
  const page = Math.min(parsePage(params.get("page")), MAX_PAGE);

  return {
    q,
    filters: filters as ListQuery<F, S>["filters"],
    sort,
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

export type ListPage<T> = { items: T[]; total: number; page: number; pageSize: number };

/** The list response body: `{ items, total, page, pageSize }`. */
export function pageResult<T>(items: T[], total: number, query: { page: number; pageSize: number }): ListPage<T> {
  return { items, total, page: query.page, pageSize: query.pageSize };
}

// ---------- Prisma helpers ----------

type Direction = "asc" | "desc";

/**
 * How a sortable column maps to Prisma `orderBy`: a field path ("createdAt", "account.legalName"), a path with a nulls
 * position (nullable columns), or a function for anything else (e.g. `_count`).
 */
export type SortColumn =
  | string
  | { path: string; nulls?: "first" | "last" }
  | ((dir: Direction) => Record<string, unknown> | Record<string, unknown>[]);

function nest(path: string, leaf: unknown): Record<string, unknown> {
  const keys = path.split(".").filter(Boolean);
  if (keys.length === 0) throw new RangeError("Empty field path");
  return keys.reduceRight<Record<string, unknown>>((inner, key) => ({ [key]: inner }), leaf as never) as Record<string, unknown>;
}

/**
 * Prisma `orderBy` for the parsed sort: the mapped column (default: the sort id as a field path), then a tie-breaker
 * (default `id`, same direction) so offset paging is stable. Cast the result to the model's OrderByWithRelationInput[]
 * with the type parameter.
 */
export function toPrismaOrderBy<T = Record<string, unknown>>(
  sort: { id: string; desc: boolean },
  columns: Readonly<Record<string, SortColumn>> = {},
  opts: { tiebreak?: string | null } = {},
): T[] {
  const dir: Direction = sort.desc ? "desc" : "asc";
  const column = Object.prototype.hasOwnProperty.call(columns, sort.id) ? columns[sort.id] : sort.id;
  const out: Record<string, unknown>[] = [];
  let primaryPath: string | null = null;
  if (typeof column === "function") {
    const result = column(dir);
    out.push(...(Array.isArray(result) ? result : [result]));
  } else if (typeof column === "string") {
    primaryPath = column;
    out.push(nest(column, dir));
  } else if (column) {
    primaryPath = column.path;
    out.push(nest(column.path, column.nulls ? { sort: dir, nulls: column.nulls } : dir));
  }
  const tiebreak = opts.tiebreak === undefined ? "id" : opts.tiebreak;
  if (tiebreak && tiebreak !== primaryPath) out.push(nest(tiebreak, dir));
  return out as T[];
}

export type SearchField = string | { path: string; match?: "contains" | "startsWith" | "equals"; caseSensitive?: boolean };

/**
 * `{ OR: [...] }` matching `q` against the given field paths (case-insensitive `contains` by default; use
 * `startsWith`/`equals` for indexed ids at scale), or undefined when there is no search. Cast with the type parameter.
 */
export function searchWhere<T = Record<string, unknown>>(q: string, fields: readonly SearchField[]): T | undefined {
  const term = q.trim();
  if (!term || fields.length === 0) return undefined;
  const OR = fields.map((field) => {
    const f = typeof field === "string" ? { path: field } : field;
    const condition: Record<string, unknown> = { [f.match ?? "contains"]: term };
    if (!f.caseSensitive) condition.mode = "insensitive";
    return nest(f.path, condition);
  });
  return { OR } as T;
}
