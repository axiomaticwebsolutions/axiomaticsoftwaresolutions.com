"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Cell,
  type Column,
  type Row,
  type SortingState,
} from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { csvFileName, downloadCsv, toCsv } from "@/lib/csv";
import { Icon } from "@/components/icons/icon";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { toast } from "@/components/ui/sonner";
import { BulkBar } from "@/components/data-table/bulk-bar";
import { ColumnHeader } from "@/components/data-table/column-header";
import { DataTableEmptyState } from "@/components/data-table/empty-state";
import { columnLabel, MobileCards } from "@/components/data-table/mobile-cards";
import {
  ariaSortFor,
  clampPage,
  columnSortsDescFirst,
  headerCheckState,
  nextSorting,
  pageCount,
  pageRange,
  parseSortOptionValue,
  sliceForPage,
  sortSelectOptions,
  toggleAllVisible,
  toggleId,
} from "@/components/data-table/model";
import { Pagination } from "@/components/data-table/pagination";
import { SkeletonRows } from "@/components/data-table/skeleton-rows";
import { alignClass, VARIANT_STYLES } from "@/components/data-table/styles";
import { Toolbar, toolbarIsFiltered } from "@/components/data-table/toolbar";
import type { DataTableProps, DataTableVariant } from "@/components/data-table/types";

/** Clicks on these inside a row do their own thing and never open the row. */
const INTERACTIVE =
  "a,button,input,select,textarea,label,summary,[role='checkbox'],[role='button'],[role='link'],[role='switch'],[data-row-click-ignore]";

const NO_IDS: readonly string[] = [];

function useLatest<V>(value: V): React.RefObject<V> {
  const ref = React.useRef(value);
  React.useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Whether a column sorts: explicit enableSorting wins (server-sorted display columns), else it needs an accessor. */
function canSort<T>(column: Column<T, unknown>): boolean {
  const flag = column.columnDef.enableSorting;
  return flag === true || (flag !== false && !!column.accessorFn);
}

/**
 * Generic data table for the portal and the admin console.
 *
 * - Real <table> with a caption, th scope, aria-sort on the sorted column, row headers (<th scope="row">).
 * - Controlled sorting / paging (URL-synced by callers, see useListState) or client-side for small sets; set
 *   pagination.total for server paging.
 * - Selection with labelled checkboxes, an indeterminate select-all for the visible rows, and a bulk bar announced
 *   through a live region.
 * - rowHref makes the row header cell a link (and the row clickable); onRowClick adds an "Open" button per row.
 * - Below 760px the rows become a list of cards (mobileCard, or one built from the columns).
 * - Rows are memoised: selecting one row re-renders that row, not the other 999.
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  getRowLabel = getRowId,
  caption,
  captionVisible = false,
  variant = "portal",
  toolbar,
  stats,
  sorting: sortingProp,
  onSortingChange,
  defaultSorting,
  sortDescFirst = false,
  manual: manualProp,
  pagination,
  selection,
  emptyState,
  errorState,
  footer,
  mobileCard,
  loading = false,
  onRowClick,
  rowHref,
  minWidth,
  hideTableWhenEmpty = false,
  className,
  tableClassName,
  rowClassName,
  id,
}: DataTableProps<T>) {
  const styles = VARIANT_STYLES[variant];
  const router = useRouter();
  const captionId = React.useId();
  const manual = manualProp ?? pagination?.total !== undefined;

  const [innerSorting, setInnerSorting] = React.useState<SortingState>(defaultSorting ?? []);
  const sorting = sortingProp ?? innerSorting;

  const table = useReactTable<T>({
    data: data as T[],
    columns: columns as DataTableProps<T>["columns"][number][],
    getRowId: (row) => getRowId(row),
    state: { sorting },
    manualSorting: manual,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manual ? undefined : getSortedRowModel(),
  });

  const sortedRows = table.getRowModel().rows;
  const total = pagination && manual ? (pagination.total ?? sortedRows.length) : sortedRows.length;
  const page = pagination ? clampPage(pagination.page, total, pagination.pageSize) : 1;
  const clientPageSize = pagination && !manual ? pagination.pageSize : 0;
  const pagedRows = React.useMemo(
    () => (clientPageSize > 0 ? sliceForPage(sortedRows, page, clientPageSize) : sortedRows),
    [sortedRows, page, clientPageSize],
  );
  // A page past the end (a filter shrank the list, a stale link) is shown as the last page; tell the caller so the
  // URL (and a server fetch) follow.
  const requestedPage = pagination?.page;
  const onPageChangeRef = useLatest(pagination?.onPageChange);
  React.useEffect(() => {
    if (requestedPage !== undefined && !loading && requestedPage !== page) onPageChangeRef.current?.(page);
  }, [requestedPage, page, loading, onPageChangeRef]);
  const hasError = !!errorState;
  const rows = React.useMemo(() => (hasError ? [] : pagedRows), [hasError, pagedRows]);

  // Sorting: a header click flips the sorted column or sorts a new one (descending first for right-aligned
  // columns, columnDef.sortDescFirst, or the table's sortDescFirst).
  const sortingRef = useLatest(sorting);
  const applySorting = (next: SortingState) => {
    if (sortingProp === undefined) setInnerSorting(next);
    onSortingChange?.(next);
  };
  const handleSort = (column: Column<T, unknown>) => {
    applySorting(nextSorting(sortingRef.current, column.id, columnSortsDescFirst(column.columnDef, sortDescFirst)));
  };

  // Selection.
  const hasSelection = !!selection;
  const selected = selection?.selected ?? NO_IDS;
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  const isRowSelectable = selection?.isRowSelectable;
  const visibleSelectableIds = React.useMemo(
    () => (hasSelection ? rows.filter((row) => !isRowSelectable || isRowSelectable(row.original)).map((row) => row.id) : []),
    [rows, hasSelection, isRowSelectable],
  );
  const headerState = headerCheckState(selectedSet, visibleSelectableIds);
  const selectionRef = useLatest(selection);
  const toggleRow = React.useCallback(
    (rowId: string) => {
      const current = selectionRef.current;
      if (current) current.onChange(toggleId(current.selected, rowId));
    },
    [selectionRef],
  );
  const selectAllRef = React.useRef<HTMLButtonElement>(null);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const clearSelection = () => {
    selection?.onChange([]);
    // The bulk bar (and its Clear button) disappears: move focus to the select-all checkbox, or the table.
    window.requestAnimationFrame(() => {
      const box = selectAllRef.current;
      if (box && box.offsetParent !== null) box.focus();
      else frameRef.current?.focus();
    });
  };

  // Opening rows.
  const rowHrefRef = useLatest(rowHref);
  const onRowClickRef = useLatest(onRowClick);
  const clickable = !!rowHref || !!onRowClick;
  const openRow = React.useCallback(
    (rowId: string, newTab = false) => {
      const row = table.getCoreRowModel().rowsById[rowId];
      if (!row) return;
      const href = rowHrefRef.current?.(row.original);
      if (href) {
        if (newTab) window.open(href, "_blank", "noopener");
        else router.push(href);
        return;
      }
      onRowClickRef.current?.(row.original);
    },
    [table, router, rowHrefRef, onRowClickRef],
  );
  const rowFromEvent = (event: React.MouseEvent<HTMLElement>): string | null => {
    const target = event.target as HTMLElement;
    const tr = target.closest<HTMLElement>("tr[data-row-id]");
    if (!tr || !event.currentTarget.contains(tr)) return null;
    const hit = target.closest(INTERACTIVE);
    if (hit && tr.contains(hit)) return null;
    // Selecting text in a cell is not a click on the row.
    if (window.getSelection()?.toString()) return null;
    return tr.dataset.rowId ?? null;
  };
  const onBodyClick = (event: React.MouseEvent<HTMLTableSectionElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const rowId = rowFromEvent(event);
    if (rowId) openRow(rowId, !!rowHref && (event.metaKey || event.ctrlKey));
  };
  const onBodyAuxClick = (event: React.MouseEvent<HTMLTableSectionElement>) => {
    if (event.button !== 1 || !rowHref) return;
    const rowId = rowFromEvent(event);
    if (rowId) openRow(rowId, true);
  };

  // CSV export from the toolbar.
  const [exporting, setExporting] = React.useState(false);
  const csv = toolbar?.csv;
  const runExport = async () => {
    if (!csv) return;
    const exportRows = sortedRows.map((row) => row.original);
    try {
      if (csv.onExport) {
        setExporting(true);
        await csv.onExport(exportRows);
      } else if (csv.columns) {
        downloadCsv(csv.fileName, toCsv(exportRows, csv.columns));
        const n = exportRows.length;
        toast.success(`Exported ${n.toLocaleString("en-IN")} ${n === 1 ? "row" : "rows"} to ${csvFileName(csv.fileName)}`);
      }
    } catch {
      toast.error("Couldn\u2019t export. Try again.");
    } finally {
      setExporting(false);
    }
  };

  const leafColumns = table.getVisibleLeafColumns();
  const primaryColumnId = (leafColumns.find((column) => column.columnDef.meta?.rowHeader) ?? leafColumns[0])?.id;
  const openColumn = !!onRowClick;
  const cardsEnabled = mobileCard !== false;
  const skeletonCount = Math.min(pagination?.pageSize ?? 5, 8);
  const showSkeleton = loading && rows.length === 0 && !errorState;
  const isEmpty = !loading && rows.length === 0 && !errorState;
  const filtered = toolbar ? toolbarIsFiltered(toolbar) : false;
  const captionText = typeof caption === "string" ? caption : undefined;
  const showTable = !(hideTableWhenEmpty && isEmpty);

  // Cards have no column headers: below 760px a "Sort" select offers the sortable columns (same ?sort= as a click).
  const sortSelect = cardsEnabled
    ? sortSelectOptions(
        leafColumns.filter(canSort).map((column) => ({
          id: column.id,
          label: columnLabel(column) ?? column.id,
          descFirst: columnSortsDescFirst(column.columnDef, sortDescFirst),
          numeric: column.columnDef.meta?.align === "right",
          labels: column.columnDef.meta?.sortLabels,
        })),
        sorting,
      )
    : null;
  const sortControl =
    sortSelect && sortSelect.options.length > 0
      ? {
          options: sortSelect.options,
          value: sortSelect.value,
          onChange: (value: string) => {
            const entry = parseSortOptionValue(value);
            if (entry) applySorting([entry]);
          },
        }
      : undefined;

  let footerText: React.ReactNode = footer ?? null;
  if (footerText === null && pagination) {
    const range = pageRange(page, pagination.pageSize, total);
    footerText =
      total > 0
        ? (pagination.rangeLabel?.(range) ?? `Showing ${range.from}\u2013${range.to} of ${range.total.toLocaleString("en-IN")}`)
        : (pagination.emptyLabel ?? "0 results");
  }
  const hasFooter = footerText !== null || !!pagination;
  const roundTop = !toolbar && selected.length === 0;

  const frame = (
    <div
      ref={frameRef}
      id={stats ? undefined : id}
      tabIndex={-1}
      data-slot="data-table"
      // The prototype tables use the font's normal line height (the page body uses 1.6).
      className={cn("min-w-0 leading-[normal]", styles.frame, stats ? undefined : className)}
    >
      {toolbar ? (
        <Toolbar {...toolbar} variant={variant} onExport={csv ? runExport : undefined} exporting={exporting} sort={sortControl} />
      ) : sortControl ? (
        <Toolbar variant={variant} sort={sortControl} className="cards:hidden" />
      ) : null}
      {selection ? (
        <BulkBar
          count={selected.length}
          onClear={clearSelection}
          clearLabel={selection.clearLabel}
          variant={variant}
          className={cardsEnabled && !selection.onMobile ? "hidden cards:flex" : undefined}
        >
          {selection.bulkActions}
        </BulkBar>
      ) : null}
      <p role="status" className="sr-only">
        {loading ? "Loading" : ""}
      </p>
      {showTable ? (
        <ScrollRegion
          labelledBy={caption ? captionId : undefined}
          className={cn(
            cardsEnabled && "hidden cards:block",
            roundTop && (variant === "admin" ? "rounded-t-[13px]" : "rounded-t-[15px]"),
            !hasFooter && (variant === "admin" ? "rounded-b-[13px]" : "rounded-b-[15px]"),
          )}
        >
          <table
            aria-busy={loading || undefined}
            className={cn("w-full border-collapse text-ink", styles.table, tableClassName)}
            style={minWidth ? { minWidth } : undefined}
          >
            {caption ? (
              <caption
                id={captionId}
                className={captionVisible ? "caption-top px-3.5 pb-2 pt-3 text-left text-[13px] font-bold text-ink-2" : "sr-only"}
              >
                {caption}
              </caption>
            ) : null}
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id} className={cn("bg-bg text-left tracking-[0.06em] text-ink-2", styles.headRow)}>
                  {hasSelection ? (
                    <th scope="col" className={cn(styles.head, styles.edgeLeft, styles.selectCell)}>
                      {visibleSelectableIds.length > 0 ? (
                        <Checkbox
                          ref={selectAllRef}
                          size={styles.selectCheckbox}
                          aria-label={selection?.selectAllLabel ?? "Select all"}
                          checked={headerState}
                          onCheckedChange={() => selection?.onChange(toggleAllVisible(selected, visibleSelectableIds))}
                          className="align-middle"
                        />
                      ) : (
                        <span className="sr-only">{selection?.selectAllLabel ?? "Select all"}</span>
                      )}
                    </th>
                  ) : null}
                  {group.headers.map((header, index) => {
                    const column = header.column;
                    const meta = column.columnDef.meta;
                    const first = index === 0 && !hasSelection;
                    const last = index === group.headers.length - 1 && !openColumn;
                    return (
                      <ColumnHeader
                        key={header.id}
                        colSpan={header.colSpan > 1 ? header.colSpan : undefined}
                        align={meta?.align}
                        srLabel={meta?.srLabel}
                        sortable={!header.isPlaceholder && canSort(column)}
                        sort={ariaSortFor(sorting, column.id)}
                        onSort={() => handleSort(column)}
                        className={cn(styles.head, first && styles.edgeLeft, last && styles.edgeRight, meta?.headerClassName)}
                      >
                        {/* srLabel replaces the header (TanStack gives header-less columns a default renderer). */}
                        {header.isPlaceholder || meta?.srLabel ? null : flexRender(column.columnDef.header, header.getContext())}
                      </ColumnHeader>
                    );
                  })}
                  {openColumn ? (
                    <th scope="col" className={cn(styles.head, styles.edgeRight, "w-10")}>
                      <span className="sr-only">Open</span>
                    </th>
                  ) : null}
                </tr>
              ))}
            </thead>
            {/* Mouse convenience only: every clickable row also has a real link or "Open" button for keyboards. */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
            <tbody onClick={clickable ? onBodyClick : undefined} onAuxClick={rowHref ? onBodyAuxClick : undefined}>
              {showSkeleton ? (
                <SkeletonRows
                  columns={leafColumns.length}
                  rows={skeletonCount}
                  leadingCheckbox={hasSelection}
                  trailingCell={openColumn}
                  cellClassName={styles.cell}
                />
              ) : null}
              {rows.map((row) => (
                <DataTableRow
                  key={row.id}
                  row={row}
                  cells={row.getVisibleCells()}
                  selected={selectedSet.has(row.id)}
                  showSelection={hasSelection}
                  selectable={hasSelection && (!isRowSelectable || isRowSelectable(row.original))}
                  onToggle={toggleRow}
                  label={getRowLabel(row.original)}
                  href={rowHref ? rowHref(row.original) : undefined}
                  openColumn={openColumn}
                  onOpen={openRow}
                  primaryColumnId={primaryColumnId}
                  variant={variant}
                  clickable={clickable}
                  dimmed={loading}
                  className={rowClassName?.(row.original)}
                />
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      ) : null}
      {cardsEnabled ? (
        <MobileCards
          className="cards:hidden"
          rows={rows}
          render={typeof mobileCard === "function" ? mobileCard : undefined}
          primaryColumnId={primaryColumnId}
          rowHref={rowHref}
          onOpen={onRowClick ? openRow : undefined}
          getRowLabel={getRowLabel}
          selection={
            selection?.onMobile ? { selected: selectedSet, isSelectable: isRowSelectable, onToggle: toggleRow } : undefined
          }
          loading={showSkeleton}
          skeletonCount={Math.min(skeletonCount, 4)}
          variant={variant}
          label={captionText}
        />
      ) : null}
      {errorState ? (
        typeof errorState === "string" ? (
          <DataTableEmptyState tone="error" icon="error" variant={variant}>
            {errorState}
          </DataTableEmptyState>
        ) : (
          errorState
        )
      ) : null}
      {isEmpty ? (
        emptyState === undefined || typeof emptyState === "string" ? (
          <DataTableEmptyState variant={variant}>
            {emptyState ?? (filtered ? "Nothing matches your search or filters." : "No records yet.")}
          </DataTableEmptyState>
        ) : (
          emptyState
        )
      ) : null}
      {hasFooter ? (
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-2.5 border-t border-line-subtle text-[12.5px] font-semibold text-ink-2",
            styles.footer,
          )}
        >
          <p role="status" className="min-w-0">
            {footerText}
          </p>
          {pagination ? (
            <Pagination
              page={page}
              pageCount={pageCount(total, pagination.pageSize)}
              onPageChange={pagination.onPageChange}
              pageHref={pagination.pageHref}
              style={pagination.style ?? (variant === "admin" ? "compact" : "prev-next")}
              label={pagination.label}
              variant={variant}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (!stats) return frame;
  return (
    <div id={id} className={cn("grid min-w-0 gap-3.5", className)}>
      {stats}
      {frame}
    </div>
  );
}

type DataTableRowProps<T> = {
  row: Row<T>;
  cells: Cell<T, unknown>[];
  selected: boolean;
  showSelection: boolean;
  selectable: boolean;
  onToggle: (rowId: string) => void;
  label: string;
  href?: string;
  openColumn: boolean;
  onOpen: (rowId: string) => void;
  primaryColumnId?: string;
  variant: DataTableVariant;
  clickable: boolean;
  dimmed: boolean;
  className?: string;
};

function DataTableRowImpl<T>({
  row,
  cells,
  selected,
  showSelection,
  selectable,
  onToggle,
  label,
  href,
  openColumn,
  onOpen,
  primaryColumnId,
  variant,
  clickable,
  dimmed,
  className,
}: DataTableRowProps<T>) {
  const styles = VARIANT_STYLES[variant];
  return (
    <tr
      data-row-id={row.id}
      data-state={selected ? "selected" : undefined}
      className={cn(
        "border-t border-line-subtle transition-[background-color,opacity] duration-150 data-[state=selected]:bg-lavender-soft/50",
        (clickable || showSelection) && "hover:bg-lavender-soft/50",
        clickable && "cursor-pointer",
        dimmed && "opacity-60",
        className,
      )}
    >
      {showSelection ? (
        <td data-row-click-ignore className={cn(styles.cell, styles.edgeLeft, styles.selectCell)}>
          {selectable ? (
            <Checkbox
              size={styles.selectCheckbox}
              aria-label={`Select ${label}`}
              checked={selected}
              onCheckedChange={() => onToggle(row.id)}
              className="align-middle"
            />
          ) : null}
        </td>
      ) : null}
      <RowCells
        cells={cells}
        showSelection={showSelection}
        openColumn={openColumn}
        primaryColumnId={primaryColumnId}
        href={href}
        variant={variant}
      />
      {openColumn ? (
        <td className={cn(styles.cell, styles.edgeRight, "w-10 text-right")}>
          <button
            type="button"
            aria-label={`Open ${label}`}
            onClick={() => onOpen(row.id)}
            className="inline-grid size-7 cursor-pointer place-items-center rounded-8 text-muted-icon hover:bg-lavender-bg hover:text-lavender-fg"
          >
            <Icon name="chevron_right" size={18} />
          </button>
        </td>
      ) : null}
    </tr>
  );
}

const DataTableRow = React.memo(DataTableRowImpl) as typeof DataTableRowImpl;

/** The data cells of a row, memoised apart from the checkbox so selecting rows does not re-render their cells. */
function RowCellsImpl<T>({
  cells,
  showSelection,
  openColumn,
  primaryColumnId,
  href,
  variant,
}: {
  cells: Cell<T, unknown>[];
  showSelection: boolean;
  openColumn: boolean;
  primaryColumnId?: string;
  href?: string;
  variant: DataTableVariant;
}) {
  const styles = VARIANT_STYLES[variant];
  const last = cells.length - 1;
  return (
    <>
      {cells.map((cell, index) => {
        const meta = cell.column.columnDef.meta;
        const content = flexRender(cell.column.columnDef.cell, cell.getContext());
        const cellClass = cn(
          "align-middle",
          styles.cell,
          index === 0 && !showSelection && styles.edgeLeft,
          index === last && !openColumn && styles.edgeRight,
          alignClass(meta?.align),
          meta?.className,
        );
        if (cell.column.id === primaryColumnId) {
          return (
            <th key={cell.id} scope="row" className={cn(cellClass, "font-normal")}>
              {href ? (
                <Link href={href} className="block rounded-6 text-ink no-underline">
                  {content}
                </Link>
              ) : (
                content
              )}
            </th>
          );
        }
        return (
          <td key={cell.id} className={cellClass}>
            {content}
          </td>
        );
      })}
    </>
  );
}

const RowCells = React.memo(RowCellsImpl) as typeof RowCellsImpl;
