/**
 * Shared list plumbing for the Customers, Licenses and Renewals modules (decisions.md Phase 6 "Lists"): one normalised
 * query shape that both the server pages (URL state through lib/url-state.ts) and the API routes (lib/admin/list-query.ts)
 * produce, so the services in lib/admin/{customers,licenses,renewals} take the same input either way. Pure and
 * client-safe.
 */
import { parseListState, type ListStateConfig, type SearchParamsInput } from "@/lib/url-state";

/** Page sizes a URL may ask for (?pageSize=); the admin API caps pageSize at 100. */
export const ADMIN_PAGE_SIZES = [10, 25, 50, 100] as const;
/** Rows per page in the admin tables (api-contracts: pageSize=25). */
export const ADMIN_LIST_PAGE_SIZE = 25;

export type AdminListQuery<F extends string, S extends string> = {
  /** Normalised search ("" for none). */
  q: string;
  /** Only filters that are set (no "all"). */
  filters: Partial<Record<F, string>>;
  sort: { id: S; desc: boolean };
  page: number;
  pageSize: number;
};

/** Query of a server page from its search params, read with the same config the client table writes. */
export function listQueryFromSearchParams<F extends string, S extends string>(
  input: SearchParamsInput | null | undefined,
  config: ListStateConfig<F>,
  fallbackSort: { id: S; desc: boolean },
): AdminListQuery<F, S> {
  const state = parseListState(input, config);
  const filters: Partial<Record<F, string>> = {};
  for (const [key, value] of Object.entries(state.filters) as [F, string][]) {
    if (value && value !== "all") filters[key] = value;
  }
  const sort = (state.sort ?? fallbackSort) as { id: S; desc: boolean };
  return { q: state.q, filters, sort, page: state.page, pageSize: state.pageSize };
}

/** Same shape from lib/admin/list-query.ts parseListQuery() (API routes). */
export function listQueryFromParsed<F extends string, S extends string>(parsed: {
  q: string;
  filters: Partial<Record<F, unknown>>;
  sort: { id: S; desc: boolean };
  page: number;
  pageSize: number;
}): AdminListQuery<F, S> {
  const filters: Partial<Record<F, string>> = {};
  for (const [key, value] of Object.entries(parsed.filters) as [F, unknown][]) {
    if (typeof value === "string" && value !== "") filters[key] = value;
  }
  return { q: parsed.q, filters, sort: parsed.sort, page: parsed.page, pageSize: parsed.pageSize };
}

/** Product ids are slugs ("medical-billing"); anything else is ignored as a filter value. */
export function productFilterParam(raw: string): string | undefined {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw) ? raw : undefined;
}

/** Search value for SQL ILIKE with "!" as the escape character (no backslashes to double up anywhere). */
export function likeContains(q: string): string {
  return `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

/** "1 license" / "3 licenses". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

/** "2026-10-07": an IST calendar date for CSV files (decisions.md Phase 5 "CSV files"). */
export function csvDateIST(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  const ist = new Date(d.getTime() + 330 * 60_000);
  return ist.toISOString().slice(0, 10);
}

/** Download name with today's IST date: "licenses-2026-10-07.csv". */
export function datedCsvName(base: string, now: Date): string {
  return `${base}-${csvDateIST(now)}.csv`;
}

/** Readable filter summary for the export audit row: "status: expiring · product: medical-billing · search". */
export function filterSummary(query: { q: string; filters: Record<string, unknown> }): string | null {
  const parts = Object.entries(query.filters)
    .filter(([, v]) => typeof v === "string" && v !== "")
    .map(([k, v]) => `${k}: ${String(v)}`);
  if (query.q) parts.push("search");
  return parts.length > 0 ? parts.join(" \u00B7 ") : null;
}

/** The "All" choice every admin filter select starts with (the URL leaves it out). */
export const ALL_OPTION = { value: "all", label: "All" } as const;

/** Filter options with "All" first. */
export function withAll<O extends { value: string; label: string }>(options: readonly O[]): { value: string; label: string }[] {
  return [ALL_OPTION, ...options];
}
