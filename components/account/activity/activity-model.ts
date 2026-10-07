/**
 * Pure helpers and copy behind the "Activity log" (Customer Portal.dc.html vActivity + actRow; decisions.md Phase 5
 * "Activity log": Owner only, 10 per page, filter by kind and search, CSV). The list state lives in the URL
 * (?kind=&q=&page=), shared by the server page (parseListState) and the client table (useListState).
 * Client-safe; unit tested in tests/unit/team-ui-model.test.ts.
 */
import type { IconName } from "@/components/icons/icon";
import { formatDateIST, formatDateTimeIST } from "@/lib/dates";
import type { ActivityEvent, ActivityPage } from "@/lib/portal/activity";
import { defineListState, type ListState } from "@/lib/url-state";
import {
  ACTIVITY_KIND_LABELS,
  ACTIVITY_KINDS,
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_RETENTION_MONTHS,
  ACTIVITY_SEARCH_MAX,
  isActivityKind,
  type ActivityQuery,
} from "@/lib/validation/team";

export type { ActivityEvent, ActivityPage };

export const ACTIVITY_COPY = {
  title: "Activity log",
  description: "Who did what on this account: key reveals, device changes, purchases, team changes and support.",
  exportCsv: "Export CSV",
  searchPlaceholder: "Person, action or item",
  searchLabel: "Search activity",
  type: "Type",
  empty: "No activity matches.",
  /** new: an account with no entries at all. */
  emptyAll: "No activity yet.",
  emptyFooter: "0 events",
  caption: "Activity log",
  pagination: "Activity log pages",
  fileName: "activity-log.csv",
  columns: { when: "When", who: "Who", action: "Action", item: "Item" },
} as const;

/** ?kind=license&q=priya&page=2 (defaults left out of the URL; no sortable columns, newest first). */
export const ACTIVITY_LIST = defineListState<"kind">({
  filters: { kind: { values: ACTIVITY_KINDS } },
  sortable: [],
  defaultSort: null,
  pageSize: ACTIVITY_PAGE_SIZE,
  maxQueryLength: ACTIVITY_SEARCH_MAX,
});

/** The "Type" select in prototype order: All activity, Licenses & devices, Security, Billing, Team, Support, Downloads. */
export const ACTIVITY_KIND_OPTIONS: readonly { value: string; label: string }[] = (["all", ...ACTIVITY_KINDS] as const).map(
  (value) => ({ value, label: ACTIVITY_KIND_LABELS[value] }),
);

/** The API query for a list state (an unknown kind reads as "all"). */
export function activityQueryFromState(state: Pick<ListState<"kind">, "q" | "filters" | "page">): ActivityQuery {
  const kind = state.filters.kind;
  return { kind: isActivityKind(kind) ? kind : "all", q: state.q, page: state.page };
}

export type ActivityTone = "lavender" | "blue" | "sage" | "peach" | "pink";
export type ActivityVisual = { icon: IconName; tone: ActivityTone };

const VISUALS: Readonly<Record<string, ActivityVisual>> = {
  license: { icon: "key", tone: "lavender" },
  ticket: { icon: "support_agent", tone: "blue" },
  team: { icon: "group", tone: "sage" },
  billing: { icon: "receipt_long", tone: "peach" },
  download: { icon: "download", tone: "blue" },
  security: { icon: "shield", tone: "pink" },
};

/** The 24px kind tile of a row (prototype actRow); unknown kinds get "history" in lavender. */
export function activityVisual(kind: string): ActivityVisual {
  return VISUALS[kind] ?? { icon: "history", tone: "lavender" };
}

/** WHEN column: "7 Oct 2026" (IST). */
export function activityDate(at: string): string {
  return formatDateIST(new Date(at));
}

/** Full time for the cell's tooltip and screen readers: "7 Oct 2026, 14:05 IST". */
export function activityDateTime(at: string): string {
  return `${formatDateTimeIST(new Date(at))} IST`;
}

/** Footer: "Showing 1–10 of 12 events · kept for 24 months" (en-IN grouping). */
export function activityRangeLabel(range: { from: number; to: number; total: number }): string {
  return `Showing ${range.from}\u2013${range.to} of ${range.total.toLocaleString("en-IN")} events \u00b7 kept for ${ACTIVITY_RETENTION_MONTHS} months`;
}

/** GET /api/account/activity/export.csv for the filters the table shows (all matching rows, not just the page). */
export function activityExportPath(query: Pick<ActivityQuery, "kind" | "q">): string {
  const params = new URLSearchParams();
  if (query.kind !== "all") params.set("kind", query.kind);
  if (query.q.trim()) params.set("q", query.q.trim());
  const search = params.toString();
  return `/api/account/activity/export.csv${search ? `?${search}` : ""}`;
}

/** Prototype toast "Exported {n} rows to activity-log.csv" ("1 row"); the server caps an export at 20,000 rows. */
export function activityExportToast(rows: number, fileName: string, truncated: boolean): string {
  const count = `${rows.toLocaleString("en-IN")} ${rows === 1 ? "row" : "rows"}`;
  return truncated ? `Exported the newest ${count} to ${fileName}` : `Exported ${count} to ${fileName}`;
}

/** Row count from the export's X-Row-Count header (null when missing or malformed). */
export function rowCountFrom(header: string | null): number | null {
  if (header === null || !/^\d{1,9}$/.test(header.trim())) return null;
  return Number(header.trim());
}
