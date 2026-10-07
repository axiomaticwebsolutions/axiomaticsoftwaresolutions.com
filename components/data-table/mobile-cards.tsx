"use client";

import * as React from "react";
import Link from "next/link";
import { flexRender, type Cell, type Column, type Row } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { Checkbox } from "@/components/ui/checkbox";
import { SkeletonCards } from "@/components/data-table/skeleton-rows";
import { VARIANT_STYLES } from "@/components/data-table/styles";
import type { DataTableVariant } from "@/components/data-table/types";

export type MobileCardsProps<T> = {
  rows: readonly Row<T>[];
  /** Custom card content; without it a card is built from the columns. */
  render?: (row: T) => React.ReactNode;
  primaryColumnId?: string;
  rowHref?: (row: T) => string;
  onOpen?: (id: string) => void;
  getRowLabel: (row: T) => string;
  /** Checkbox per card (selection.onMobile). */
  selection?: {
    selected: ReadonlySet<string>;
    isSelectable?: (row: T) => boolean;
    onToggle: (id: string) => void;
  };
  loading?: boolean;
  skeletonCount?: number;
  variant?: DataTableVariant;
  /** Accessible name of the list (usually the table caption). */
  label?: string;
  className?: string;
};

/** Plain-text name of a column for a card label: meta.label, then a string header. */
export function columnLabel<T>(column: Column<T, unknown>): string | undefined {
  const meta = column.columnDef.meta;
  if (meta?.label) return meta.label;
  const header = column.columnDef.header;
  return typeof header === "string" && header.trim() ? header : undefined;
}

/**
 * Rows as a list of cards below the cards breakpoint (760px): one <li> per row. With rowHref a custom card is one
 * link, with onRowClick one button; the default card links its title and lists the other columns as label/value.
 */
export function MobileCards<T>({
  rows,
  render,
  primaryColumnId,
  rowHref,
  onOpen,
  getRowLabel,
  selection,
  loading = false,
  skeletonCount = 4,
  variant = "portal",
  label,
  className,
}: MobileCardsProps<T>) {
  const styles = VARIANT_STYLES[variant];
  return (
    <ul
      aria-label={label}
      aria-busy={loading || undefined}
      data-slot="data-table-cards"
      className={cn("divide-y divide-line-subtle", className)}
    >
      {loading && rows.length === 0 ? <SkeletonCards rows={skeletonCount} className={styles.card} /> : null}
      {rows.map((row) => {
        const original = row.original;
        const selectable = selection ? (selection.isSelectable ? selection.isSelectable(original) : true) : false;
        return (
          <MobileCard
            key={row.id}
            row={row}
            cells={row.getVisibleCells()}
            render={render}
            primaryColumnId={primaryColumnId}
            href={rowHref ? rowHref(original) : undefined}
            onOpen={onOpen}
            label={getRowLabel(original)}
            showCheckbox={!!selection}
            selectable={selectable}
            selected={selection ? selection.selected.has(row.id) : false}
            onToggle={selection?.onToggle}
            variant={variant}
            dimmed={loading}
          />
        );
      })}
    </ul>
  );
}

type MobileCardProps<T> = {
  row: Row<T>;
  cells: Cell<T, unknown>[];
  render?: (row: T) => React.ReactNode;
  primaryColumnId?: string;
  href?: string;
  onOpen?: (id: string) => void;
  label: string;
  showCheckbox: boolean;
  selectable: boolean;
  selected: boolean;
  onToggle?: (id: string) => void;
  variant: DataTableVariant;
  dimmed: boolean;
};

function renderCell<T>(cell: Cell<T, unknown>): React.ReactNode {
  return flexRender(cell.column.columnDef.cell, cell.getContext());
}

function MobileCardImpl<T>({
  row,
  cells,
  render,
  primaryColumnId,
  href,
  onOpen,
  label,
  showCheckbox,
  selectable,
  selected,
  onToggle,
  variant,
  dimmed,
}: MobileCardProps<T>) {
  const styles = VARIANT_STYLES[variant];
  const interactive = "transition-colors duration-150 hover:bg-lavender-soft/50 focus-visible:-outline-offset-2";
  let body: React.ReactNode;

  if (render) {
    const content = render(row.original);
    if (href) {
      body = (
        <Link href={href} className={cn("grid min-w-0 flex-1 gap-2 text-ink no-underline", styles.card, interactive)}>
          {content}
        </Link>
      );
    } else if (onOpen) {
      body = (
        <button
          type="button"
          onClick={() => onOpen(row.id)}
          className={cn("grid w-full min-w-0 flex-1 cursor-pointer gap-1.5 text-left", styles.card, interactive)}
        >
          {content}
        </button>
      );
    } else {
      body = <div className={cn("grid min-w-0 flex-1 gap-2", styles.card)}>{content}</div>;
    }
  } else {
    body = (
      <DefaultCard
        cells={cells}
        primaryColumnId={primaryColumnId}
        href={href}
        onOpen={onOpen}
        rowId={row.id}
        label={label}
        className={styles.card}
      />
    );
  }

  return (
    <li
      data-state={selected ? "selected" : undefined}
      className={cn("flex items-start data-[state=selected]:bg-lavender-soft/50", dimmed && "opacity-60")}
    >
      {showCheckbox ? (
        <div className={cn("shrink-0 pr-0", styles.card)}>
          {selectable ? (
            <Checkbox aria-label={`Select ${label}`} checked={selected} onCheckedChange={() => onToggle?.(row.id)} className="mt-px" />
          ) : (
            <span className="block size-[18px]" />
          )}
        </div>
      ) : null}
      {body}
    </li>
  );
}

const MobileCard = React.memo(MobileCardImpl) as typeof MobileCardImpl;

function DefaultCard<T>({
  cells,
  primaryColumnId,
  href,
  onOpen,
  rowId,
  label,
  className,
}: {
  cells: Cell<T, unknown>[];
  primaryColumnId?: string;
  href?: string;
  onOpen?: (id: string) => void;
  rowId: string;
  label: string;
  className: string;
}) {
  const primary = cells.find((cell) => cell.column.id === primaryColumnId) ?? cells[0];
  const rest = cells.filter((cell) => cell !== primary && !cell.column.columnDef.meta?.hideOnCard);
  const fields = rest.filter((cell) => columnLabel(cell.column));
  const actions = rest.filter((cell) => !columnLabel(cell.column));

  return (
    <div className={cn("grid min-w-0 flex-1 gap-2.5", className)}>
      {primary ? (
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {href ? (
              <Link href={href} className="block rounded-6 text-ink no-underline hover:text-primary-link-hover">
                {renderCell(primary)}
              </Link>
            ) : (
              renderCell(primary)
            )}
          </div>
          {onOpen ? (
            <button
              type="button"
              aria-label={`Open ${label}`}
              onClick={() => onOpen(rowId)}
              className="-mr-1 grid size-8 shrink-0 cursor-pointer place-items-center rounded-8 text-muted-icon hover:bg-lavender-bg hover:text-lavender-fg"
            >
              <Icon name="chevron_right" size={20} />
            </button>
          ) : null}
        </div>
      ) : null}
      {fields.length > 0 ? (
        <dl className="grid gap-1.5 text-[13px]">
          {fields.map((cell) => (
            <div key={cell.id} className="flex min-w-0 items-start justify-between gap-3">
              <dt className="shrink-0 pt-px text-[11.5px] font-extrabold uppercase tracking-[0.06em] text-ink-2">
                {columnLabel(cell.column)}
              </dt>
              <dd className="min-w-0 text-right font-semibold">{renderCell(cell)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {actions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((cell) => (
            <React.Fragment key={cell.id}>{renderCell(cell)}</React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
