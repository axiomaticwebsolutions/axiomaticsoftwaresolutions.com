import type * as React from "react";
import type { ColumnDef, RowData, SortingState } from "@tanstack/react-table";
import type { CsvColumn } from "@/lib/csv";

declare module "@tanstack/react-table" {
  // TanStack's declaration has these exact type parameters; augmentations must repeat them.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Cell and header alignment (default left). Right-aligned columns sort descending first (amounts, counts). */
    align?: "left" | "center" | "right";
    /** Classes for the body cell (td / row header th). */
    className?: string;
    /** Classes for the header cell. */
    headerClassName?: string;
    /** Visually hidden header text for a column without a visible header ("Actions"); replaces the header. */
    srLabel?: string;
    /** Plain-text column name for the default mobile card (defaults to a string header, then srLabel). */
    label?: string;
    /**
     * The cell that names the row: rendered as <th scope="row">, and it carries the row link when the table has
     * `rowHref`. Defaults to the first column.
     */
    rowHeader?: boolean;
    /** Leave this column out of the default mobile card. */
    hideOnCard?: boolean;
    /**
     * Direction words in the phone "Sort" select ("Date: newest first"). Default "lowest first" / "highest first"
     * for right-aligned columns, else "ascending" / "descending".
     */
    sortLabels?: { asc: string; desc: string };
  }
}

/** Portal tables (13.5px, 38px controls, radius 16) or the admin console's denser generic table. */
export type DataTableVariant = "portal" | "admin";

export type DataTableOption = { value: string; label: string };

export type DataTableFilter = {
  id: string;
  /** Visible label before the select ("Status"); also its accessible name. */
  label: string;
  options: readonly DataTableOption[];
  value: string;
  onChange: (value: string) => void;
  /** The "no filter" value (default "all"). The toolbar's Clear button shows while any filter differs from it. */
  defaultValue?: string;
};

export type DataTableSearch = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name (visually hidden), e.g. "Search licenses". Defaults to "Search". */
  label?: string;
  /**
   * Classes for the search field, e.g. a wider flex basis (`flex-[1_1_320px]`) so a long placeholder shows in full and
   * the filters wrap to the next row instead.
   */
  className?: string;
};

export type DataTableCsv<T> = {
  /** Download name, e.g. "licenses.csv". */
  fileName: string;
  /** Client-side export: the table writes every current row (sorted, all pages) with these columns. */
  columns?: readonly CsvColumn<T>[];
  /** Custom export (server export URL, API call...). Receives the rows the table currently holds. */
  onExport?: (rows: T[]) => void | Promise<void>;
  /** Button text (default "CSV"). */
  label?: string;
  /** When set, the button is unavailable and this text explains why (tooltip), e.g. "Export needs Owner or Finance". */
  disabledReason?: string;
};

export type DataTableToolbar<T> = {
  search?: DataTableSearch;
  /** Custom controls after the search, e.g. a SegmentedControl status filter. */
  controls?: React.ReactNode;
  filters?: readonly DataTableFilter[];
  /** Shows a "Clear" button while a search or filter is active; it should reset them (and the page). */
  onClear?: () => void;
  clearLabel?: string;
  /** Overrides when Clear shows (default: search text or a filter away from its default). */
  canClear?: boolean;
  /** Result count on the right, e.g. "67 results". */
  countLabel?: React.ReactNode;
  csv?: DataTableCsv<T>;
  /** Extra buttons on the right edge. */
  actions?: React.ReactNode;
};

export type PaginationStyle = "prev-next" | "compact" | "numbered";

export type DataTablePagination = {
  /**
   * 1-based page. A page past the end is shown as the last page and reported through onPageChange (only while
   * not loading, so pass loading during a client-side fetch).
   */
  page: number;
  pageSize: number;
  /**
   * Server-side paging: the total across all pages, while `data` holds the current page only. Leave it out to let
   * the table page `data` itself (client-side).
   */
  total?: number;
  onPageChange: (page: number) => void;
  /** Real links for the page buttons (URL-synced lists): open in a new tab works, a plain click calls onPageChange. */
  pageHref?: (page: number) => string;
  /** "prev-next": Previous / Next (portal, default); "compact": arrows + "Page x of y" (admin); "numbered". */
  style?: PaginationStyle;
  /** Accessible name of the pagination nav (default "Pagination"). */
  label?: string;
  /** Footer text for an empty list (default "0 results"), e.g. "0 orders". */
  emptyLabel?: string;
  /** Footer text, default "Showing 1–8 of 23". */
  rangeLabel?: (range: { from: number; to: number; total: number }) => React.ReactNode;
};

export type DataTableSelection<T> = {
  /** Selected row ids (getRowId). Selection survives paging; prune it when the data set changes. */
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  /** Buttons for the bulk bar (use <BulkAction>). */
  bulkActions?: React.ReactNode;
  /** Rows without a checkbox (e.g. deactivated devices). */
  isRowSelectable?: (row: T) => boolean;
  /** Accessible name of the header checkbox (default "Select all"; the admin uses "Select all on this page"). */
  selectAllLabel?: string;
  /** Bulk bar button that clears the selection (default "Clear"; the admin uses "Clear selection"). */
  clearLabel?: string;
  /** Checkboxes on the mobile cards too. The prototype offers no selection below 760px (default false). */
  onMobile?: boolean;
};

export type DataTableProps<T> = {
  /** TanStack column definitions. Memoise them (useMemo or a module constant): new columns re-render every row. */
  // TanStack's own recommendation for mixed accessor value types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: readonly ColumnDef<T, any>[];
  data: readonly T[];
  getRowId: (row: T) => string;
  /** Human name of a row for "Select LIC-24017" / "Open LIC-24017" (defaults to getRowId). */
  getRowLabel?: (row: T) => string;
  /** Table caption (visually hidden unless captionVisible). Strongly recommended: it names the table. */
  caption?: React.ReactNode;
  captionVisible?: boolean;
  variant?: DataTableVariant;
  toolbar?: DataTableToolbar<T>;
  /** Stats row above the table (<DataTableStats>). */
  stats?: React.ReactNode;
  /** Controlled sorting (URL-synced by callers). Without it the table keeps its own, starting at defaultSorting. */
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  defaultSorting?: SortingState;
  /** A newly sorted column starts descending (orders) instead of ascending (licenses). Per column: sortDescFirst. */
  sortDescFirst?: boolean;
  /** Data is already sorted and paged by the server. Defaults to true when pagination.total is given. */
  manual?: boolean;
  pagination?: DataTablePagination;
  selection?: DataTableSelection<T>;
  /** Shown when there are no rows (string or <DataTableEmptyState>). */
  emptyState?: React.ReactNode;
  /** Shown instead of the rows when loading failed (<DataTableEmptyState tone="error">). */
  errorState?: React.ReactNode;
  /** Footer text when there is no pagination, e.g. "4 of 4 licenses · keys are masked; open a license to reveal". */
  footer?: React.ReactNode;
  /**
   * Card content for one row below 760px. Leave it out for a card built from the columns, or pass false to keep
   * the table (it scrolls sideways). With rowHref the whole card is a link and with onRowClick a button, so the
   * content must not contain other links or buttons (and only phrasing content inside a button). Pass a stable
   * function (module level or useCallback), like the columns: a new function re-renders every card.
   */
  mobileCard?: ((row: T) => React.ReactNode) | false;
  /** Skeleton rows when there is no data yet; dims the rows while new data loads. */
  loading?: boolean;
  /** Row click (admin drawer). Adds an "Open" button per row for keyboard and screen-reader users. */
  onRowClick?: (row: T) => void;
  /** Row link: the row header cell becomes a link and a click anywhere on the row follows it. */
  rowHref?: (row: T) => string;
  /** Table min-width in px before it scrolls sideways (prototype: 820 licenses, 860 devices, 680 activity). */
  minWidth?: number;
  /**
   * Leave the table (its header row) out when there are no rows, so only the empty state shows (prototype Licenses).
   * Default false: the header stays above the empty state (prototype Devices).
   */
  hideTableWhenEmpty?: boolean;
  className?: string;
  tableClassName?: string;
  rowClassName?: (row: T) => string | undefined;
  id?: string;
};
