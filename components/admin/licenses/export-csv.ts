"use client";

import { downloadFile } from "@/components/account/orders/download";
import { adminToast } from "@/components/admin/admin-toaster";
import { listStateToParams, type ListState, type ListStateConfig } from "@/lib/url-state";

/** "Exported 58 rows · licenses-2026-10-07.csv" (prototype toast "Exported {n} rows · {file}"). */
export function exportToast(rows: number | null, fileName: string, truncated: boolean): string {
  const n = rows === null ? "" : `${rows.toLocaleString("en-IN")} ${rows === 1 ? "row" : "rows"} `;
  return `Exported ${n}\u00B7 ${fileName}${truncated ? " (first 10,000 rows; narrow the filters for the rest)" : ""}`;
}

/** Downloads the server CSV for the list's current search, filters and sort (fetch + Blob; refusals become a toast). */
export async function exportListCsv<F extends string>(
  path: string,
  state: ListState<F>,
  config: ListStateConfig<F>,
  fallbackName: string,
): Promise<void> {
  const params = listStateToParams({ ...state, page: 1 }, config);
  params.delete("page");
  params.delete("pageSize");
  const query = params.toString();
  try {
    const { fileName, headers } = await downloadFile(`${path}${query ? `?${query}` : ""}`, fallbackName);
    const raw = headers.get("x-row-count");
    const rows = raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
    adminToast.success(exportToast(rows, fileName, headers.get("x-truncated") === "1"));
  } catch (error) {
    adminToast.error(error, "The export didn\u2019t work. Try again.");
  }
}
