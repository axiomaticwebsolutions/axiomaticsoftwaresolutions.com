"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FilterSelect } from "@/components/data-table/filter-select";
import { VARIANT_STYLES } from "@/components/data-table/styles";
import type { DataTableOption, DataTableToolbar, DataTableVariant } from "@/components/data-table/types";

export type ToolbarProps<T> = DataTableToolbar<T> & {
  variant?: DataTableVariant;
  /** Runs the CSV export (DataTable wires csv.columns / csv.onExport here). */
  onExport?: () => void;
  exporting?: boolean;
  /**
   * The "Sort" select DataTable adds while its rows are cards (below 760px there are no sortable headers); hidden
   * from 760px.
   */
  sort?: { options: readonly DataTableOption[]; value: string; onChange: (value: string) => void };
  className?: string;
};

/** True while a search or any filter differs from its default ("all"). */
export function toolbarIsFiltered<T>(toolbar: Pick<DataTableToolbar<T>, "search" | "filters" | "canClear">): boolean {
  if (toolbar.canClear !== undefined) return toolbar.canClear;
  if (toolbar.search && toolbar.search.value.trim() !== "") return true;
  return (toolbar.filters ?? []).some((filter) => filter.value !== (filter.defaultValue ?? "all"));
}

/**
 * Table toolbar: search, custom controls, filter selects, Clear, and on the right the result count, CSV and extra
 * actions. Wraps onto several lines on narrow screens.
 */
export function Toolbar<T>({
  search,
  controls,
  filters,
  onClear,
  clearLabel = "Clear",
  canClear,
  countLabel,
  csv,
  actions,
  variant = "portal",
  onExport,
  exporting = false,
  sort,
  className,
}: ToolbarProps<T>) {
  const styles = VARIANT_STYLES[variant];
  const rootRef = React.useRef<HTMLDivElement>(null);
  const showClear = !!onClear && toolbarIsFiltered({ search, filters, canClear });

  const clear = () => {
    onClear?.();
    // The Clear button disappears with the filters: keep keyboard focus in the toolbar.
    window.requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector<HTMLElement>("input[type='search'], select, button");
      target?.focus();
    });
  };

  const hasRight = countLabel !== undefined || !!csv || !!actions;

  return (
    <div
      ref={rootRef}
      data-slot="data-table-toolbar"
      className={cn("flex flex-wrap items-center border-b border-line-subtle", styles.toolbar, className)}
    >
      {search ? (
        <label
          className={cn(
            "flex min-w-0 flex-[1_1_220px] cursor-text items-center gap-1.5 border border-line-strong bg-surface px-2.5",
            "transition-[border-color,box-shadow] duration-150 focus-within:border-primary focus-within:shadow-focus",
            styles.control,
            search.className,
          )}
        >
          <Icon name="search" size={18} className="text-ink-3" />
          <span className="sr-only">{search.label ?? "Search"}</span>
          <input
            type="search"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder}
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 border-0 bg-transparent font-semibold text-ink outline-none placeholder:font-semibold placeholder:text-ink-3 focus-visible:outline-hidden"
          />
        </label>
      ) : null}
      {controls}
      {filters?.map((filter) => (
        <FilterSelect
          key={filter.id}
          label={filter.label}
          options={filter.options}
          value={filter.value}
          onValueChange={filter.onChange}
          variant={variant}
        />
      ))}
      {sort ? (
        <FilterSelect
          label="Sort"
          options={sort.options}
          value={sort.value}
          onValueChange={sort.onChange}
          variant={variant}
          labelClassName="cards:hidden"
        />
      ) : null}
      {showClear ? (
        <button
          type="button"
          onClick={clear}
          className="cursor-pointer rounded-6 px-1 text-[13px] font-bold text-primary-link hover:text-primary-link-hover hover:underline"
        >
          {clearLabel}
        </button>
      ) : null}
      {hasRight ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {countLabel !== undefined ? (
            <span className="text-[12.5px] font-semibold text-ink-2">{countLabel}</span>
          ) : null}
          {csv ? <CsvButton label={csv.label} disabledReason={csv.disabledReason} onExport={onExport} exporting={exporting} variant={variant} /> : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function CsvButton({
  label = "CSV",
  disabledReason,
  onExport,
  exporting,
  variant,
}: {
  label?: string;
  disabledReason?: string;
  onExport?: () => void;
  exporting: boolean;
  variant: DataTableVariant;
}) {
  const className = cn("gap-1.5 py-0", VARIANT_STYLES[variant].csvButton);
  if (disabledReason) {
    // aria-disabled (not disabled) so the button stays focusable and the tooltip can explain why.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="secondary" className={className} aria-disabled="true" onClick={(e) => e.preventDefault()}>
            <Icon name="download" size={17} />
            {label}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button type="button" variant="secondary" className={className} onClick={onExport} loading={exporting}>
      {exporting ? null : <Icon name="download" size={17} />}
      {label}
    </Button>
  );
}
