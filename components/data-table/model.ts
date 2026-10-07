/**
 * Pure helpers behind <DataTable>: sorting, selection, paging and search. No React, so server pages, API routes
 * and unit tests can use them too.
 */

export type SortEntry = { id: string; desc: boolean };

/** Header click: the sorted column flips; another column becomes the sort, ascending unless `descFirst`. */
export function nextSorting(current: readonly SortEntry[], columnId: string, descFirst = false): SortEntry[] {
  const active = current[0];
  if (active && active.id === columnId) return [{ id: columnId, desc: !active.desc }];
  return [{ id: columnId, desc: descFirst }];
}

/**
 * Whether a newly sorted column starts descending: its own `sortDescFirst`, else right-aligned (amounts, counts)
 * columns do, else the table default (Admin Console.dc.html: `c.align === 'right' ? -1 : 1`).
 */
export function columnSortsDescFirst(
  column: { sortDescFirst?: boolean; meta?: { align?: "left" | "center" | "right" } },
  tableDefault = false,
): boolean {
  return column.sortDescFirst ?? (column.meta?.align === "right" ? true : tableDefault);
}

/** A sortable column as the phone "Sort" select sees it. */
export type SortOptionColumn = {
  id: string;
  /** Column name, e.g. "Date". */
  label: string;
  /** A header click sorts it descending first (dates, amounts); that direction is listed first. */
  descFirst: boolean;
  /** Right-aligned (numbers, amounts): default words "lowest first" / "highest first". */
  numeric?: boolean;
  /** Direction words, e.g. { asc: "oldest first", desc: "newest first" }. */
  labels?: { asc: string; desc: string };
};

export type SortOption = { value: string; label: string };

/** "date:desc" (the phone Sort select's option value). */
export function sortOptionValue(entry: SortEntry): string {
  return `${entry.id}:${entry.desc ? "desc" : "asc"}`;
}

/** "date:desc" -> { id: "date", desc: true }; null for anything else. */
export function parseSortOptionValue(value: string): SortEntry | null {
  const at = value.lastIndexOf(":");
  if (at <= 0) return null;
  const dir = value.slice(at + 1);
  if (dir !== "asc" && dir !== "desc") return null;
  return { id: value.slice(0, at), desc: dir === "desc" };
}

/**
 * Options of the "Sort" select that replaces the sortable headers below 760px (cards have no headers): every
 * sortable column in both directions, the header's first-click direction first ("Date: newest first", "Date: oldest
 * first", "Total: highest first", ...). When the current sort is not one of them (no sort yet), "Default order" leads.
 */
export function sortSelectOptions(columns: readonly SortOptionColumn[], current: readonly SortEntry[]): { options: SortOption[]; value: string } {
  const options = columns.flatMap((column) => {
    const words = column.labels ?? (column.numeric ? { asc: "lowest first", desc: "highest first" } : { asc: "ascending", desc: "descending" });
    const order = column.descFirst ? [true, false] : [false, true];
    return order.map((desc) => ({ value: sortOptionValue({ id: column.id, desc }), label: `${column.label}: ${desc ? words.desc : words.asc}` }));
  });
  const active = current[0];
  const value = active ? sortOptionValue(active) : "";
  if (options.length > 0 && !options.some((option) => option.value === value)) options.unshift({ value, label: "Default order" });
  return { options, value };
}

/** aria-sort for a header: only the sorted column carries it (APG sortable table). */
export function ariaSortFor(current: readonly SortEntry[], columnId: string): "ascending" | "descending" | undefined {
  const active = current[0];
  if (!active || active.id !== columnId) return undefined;
  return active.desc ? "descending" : "ascending";
}

/** Header checkbox state for the rows on screen: true, false or "indeterminate". */
export function headerCheckState(selected: ReadonlySet<string>, visibleIds: readonly string[]): boolean | "indeterminate" {
  if (visibleIds.length === 0) return false;
  let count = 0;
  for (const id of visibleIds) if (selected.has(id)) count += 1;
  if (count === 0) return false;
  return count === visibleIds.length ? true : "indeterminate";
}

/** Adds or removes one id. */
export function toggleId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/**
 * Header checkbox: when every visible row is selected they are all removed, otherwise the missing ones are added.
 * Selected rows on other pages are kept.
 */
export function toggleAllVisible(selected: readonly string[], visibleIds: readonly string[]): string[] {
  const current = new Set(selected);
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => current.has(id));
  if (allOn) {
    const visible = new Set(visibleIds);
    return selected.filter((id) => !visible.has(id));
  }
  const next = [...selected];
  for (const id of visibleIds) if (!current.has(id)) next.push(id);
  return next;
}

/** Drops ids that are no longer in the data. Returns the same array when nothing changed (no extra render). */
export function pruneSelection(selected: readonly string[], keep: Iterable<string>): readonly string[] {
  const allowed = keep instanceof Set ? (keep as ReadonlySet<string>) : new Set(keep);
  const next = selected.filter((id) => allowed.has(id));
  return next.length === selected.length ? selected : next;
}

export type PageControlState = {
  /** "link" whenever pages have URLs, else "button": never depends on the page (see pageControlState). */
  kind: "link" | "button";
  /** The page the control points at: `to`, or the current page for an unavailable end. */
  page: number;
  /** aria-disabled: Previous on the first page, Next on the last (not the current page button itself). */
  disabled: boolean;
};

/**
 * One Previous / Next / numbered page control. Its element kind depends only on whether pages have URLs: React
 * replaces an element whose type changes, so a focused Next that became a button on the last page dropped keyboard
 * focus to <body>. An unavailable end stays a link to the current page, with aria-disabled.
 */
export function pageControlState(to: number, current: number, count: number, hasHref: boolean, isCurrent = false): PageControlState {
  const inRange = to >= 1 && to <= count;
  return { kind: hasHref ? "link" : "button", page: inRange ? to : current, disabled: !inRange || (to === current && !isCurrent) };
}

/** Number of pages (at least 1). */
export function pageCount(total: number, pageSize: number): number {
  if (!(pageSize > 0) || !(total > 0)) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Keeps a page inside 1..pageCount (a filter can shrink the list under the current page). */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = pageCount(total, pageSize);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(Math.floor(page), last);
}

/** 1-based "from" and "to" of the rows on a page; both 0 for an empty list. */
export function pageRange(page: number, pageSize: number, total: number): { from: number; to: number; total: number } {
  if (!(total > 0)) return { from: 0, to: 0, total: 0 };
  const current = clampPage(page, total, pageSize);
  const from = (current - 1) * pageSize + 1;
  return { from, to: Math.min(total, current * pageSize), total };
}

/** Footer text: "Showing 1–8 of 23", or the empty label ("0 orders"). */
export function rangeLabel(page: number, pageSize: number, total: number, emptyLabel = "0 results"): string {
  const { from, to } = pageRange(page, pageSize, total);
  return total > 0 ? `Showing ${from}\u2013${to} of ${total}` : emptyLabel;
}

export type PageItem = number | "gap";

/**
 * Numbered pagination: first, last, the current page and `siblings` either side, with gaps. Always the same
 * number of slots once there are enough pages, so the buttons do not jump around.
 */
export function pageItems(page: number, count: number, siblings = 1): PageItem[] {
  const total = Math.max(1, Math.floor(count));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  const slots = siblings * 2 + 5; // first, last, current, siblings and two gaps
  if (total <= slots) return Array.from({ length: total }, (_, i) => i + 1);

  const left = Math.max(current - siblings, 2);
  const right = Math.min(current + siblings, total - 1);
  const showLeftGap = left > 3;
  const showRightGap = right < total - 2;

  if (!showLeftGap) {
    const end = 3 + siblings * 2;
    return [...Array.from({ length: end }, (_, i) => i + 1), "gap", total];
  }
  if (!showRightGap) {
    const start = total - (2 + siblings * 2);
    return [1, "gap", ...Array.from({ length: total - start + 1 }, (_, i) => start + i)];
  }
  return [1, "gap", ...Array.from({ length: right - left + 1 }, (_, i) => left + i), "gap", total];
}

/** One page of rows (client-side paging). */
export function sliceForPage<T>(rows: readonly T[], page: number, pageSize: number): T[] {
  const current = clampPage(page, rows.length, pageSize);
  return rows.slice((current - 1) * pageSize, current * pageSize);
}

/** Lower-cased search terms of a query. */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Client-side search: every term of the query appears in one of the fields (case-insensitive). */
export function matchesQuery(query: string, fields: readonly (string | number | null | undefined)[]): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const haystack = fields
    .filter((field) => field !== null && field !== undefined && field !== "")
    .join(" \u0000 ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** "1 result" / "67 results". */
export function countLabel(count: number, one = "result", other = `${one}s`): string {
  return `${count.toLocaleString("en-IN")} ${count === 1 ? one : other}`;
}
