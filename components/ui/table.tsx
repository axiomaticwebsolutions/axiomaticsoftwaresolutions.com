import type * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { ScrollRegion } from "@/components/ui/scroll-region";

/**
 * Semantic table in a horizontally scrollable wrapper (the page itself never scrolls sideways). The wrapper is a
 * focusable region while it overflows (ScrollRegion); `scrollLabelledBy` names it after a visible title.
 */
export function Table({
  className,
  wrapperClassName,
  scrollLabelledBy,
  ...props
}: React.ComponentProps<"table"> & { wrapperClassName?: string; scrollLabelledBy?: string }) {
  return (
    <ScrollRegion data-slot="table-container" labelledBy={scrollLabelledBy} className={cn("w-full", wrapperClassName)}>
      <table data-slot="table" className={cn("w-full caption-bottom border-collapse text-[14px]", className)} {...props} />
    </ScrollRegion>
  );
}

export function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("bg-bg", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn(className)} {...props} />;
}

export function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot data-slot="table-footer" className={cn("border-t border-line bg-bg font-bold", className)} {...props} />
  );
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-t border-line-subtle transition-colors first:border-t-0 hover:bg-bg data-[state=selected]:bg-lavender-soft",
        className,
      )}
      {...props}
    />
  );
}

const headClassName =
  "h-10 whitespace-nowrap px-2.5 text-left align-middle text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink-2";

export function TableHead({ className, scope = "col", ...props }: React.ComponentProps<"th">) {
  return <th data-slot="table-head" scope={scope} className={cn(headClassName, className)} {...props} />;
}

export type SortDirection = "ascending" | "descending" | "none";

export type TableSortHeadProps = Omit<React.ComponentProps<"th">, "onClick"> & {
  /** Current sort of this column; sets aria-sort on the header cell. */
  sort: SortDirection;
  onSort: () => void;
  align?: "left" | "right";
};

/**
 * Sortable column header: a real button inside the th, aria-sort on the th, arrow icon for the active direction
 * (the unsorted state shows a faint both-ways icon so the column reads as sortable).
 */
export function TableSortHead({ sort, onSort, align = "left", className, children, ...props }: TableSortHeadProps) {
  const icon = sort === "ascending" ? "arrow_upward" : sort === "descending" ? "arrow_downward" : "unfold_more";
  return (
    <th
      data-slot="table-head"
      scope="col"
      aria-sort={sort}
      className={cn(headClassName, align === "right" && "text-right", className)}
      {...props}
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          "inline-flex cursor-pointer items-center gap-0.5 rounded-6 uppercase tracking-[inherit] hover:text-ink",
          align === "right" && "flex-row-reverse",
          sort !== "none" && "text-ink",
        )}
      >
        {children}
        <Icon name={icon} size={15} className={sort === "none" ? "text-ink-3" : undefined} />
      </button>
    </th>
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("px-2.5 py-3 align-middle", className)} {...props} />;
}

export function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption data-slot="table-caption" className={cn("mt-3 text-left text-[13px] text-ink-2", className)} {...props} />
  );
}
