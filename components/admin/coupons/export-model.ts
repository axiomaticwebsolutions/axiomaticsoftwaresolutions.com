/** Pure parts of the admin CSV exports (export URL and toast text), unit-tested. */
import { listStateToParams, type ListState, type ListStateConfig } from "@/lib/url-state";

/** The export URL for the list's search, filters and sort (never the page: exports take every matching row). */
export function exportHref<F extends string>(path: string, state: ListState<F>, config: ListStateConfig<F>): string {
  const params = listStateToParams({ ...state, page: 1 }, config);
  params.delete("page");
  params.delete("pageSize");
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Prototype toast "Exported {n} rows · {file}". */
export function exportToast(rows: number, fileName: string, truncated: boolean): string {
  const count = `${rows.toLocaleString("en-IN")} ${rows === 1 ? "row" : "rows"}`;
  return truncated ? `Exported the first ${count} · ${fileName}` : `Exported ${count} · ${fileName}`;
}
