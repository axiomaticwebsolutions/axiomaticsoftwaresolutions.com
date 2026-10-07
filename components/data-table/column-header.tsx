"use client";

import type * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { alignClass } from "@/components/data-table/styles";

export type ColumnHeaderProps = Omit<React.ComponentProps<"th">, "children" | "onClick"> & {
  children?: React.ReactNode;
  /** Visually hidden header text, for columns without a visible header ("Actions"). */
  srLabel?: string;
  align?: "left" | "center" | "right";
  /** Render a sort button. */
  sortable?: boolean;
  /** Current direction when this column is the sort (sets aria-sort on the th); undefined when not sorted. */
  sort?: "ascending" | "descending";
  onSort?: () => void;
};

/**
 * Column header cell (<th scope="col">). Sortable headers hold a real button; aria-sort sits on the th of the sorted
 * column only. As in the prototype only the sorted column shows an arrow; hovering or focusing another sortable
 * header shows a faint both-ways icon, so the column reads as sortable.
 */
export function ColumnHeader({
  children,
  srLabel,
  align,
  sortable = false,
  sort,
  onSort,
  className,
  ...props
}: ColumnHeaderProps) {
  const hidden = srLabel && !children ? <span className="sr-only">{srLabel}</span> : null;
  return (
    <th
      scope="col"
      aria-sort={sortable ? sort : undefined}
      className={cn("whitespace-nowrap font-extrabold uppercase", alignClass(align), className)}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            // align-middle: a reversed inline-flex (right-aligned columns) would otherwise sit on the icon's baseline.
            "group/sort inline-flex cursor-pointer items-center gap-0.5 rounded-6 align-middle font-[inherit] uppercase tracking-[inherit] text-inherit",
            "hover:text-ink",
            align === "right" && "flex-row-reverse",
            sort && "text-ink",
          )}
        >
          {children}
          {hidden}
          {sort ? (
            <Icon name={sort === "ascending" ? "arrow_upward" : "arrow_downward"} size={16} />
          ) : (
            <Icon
              name="unfold_more"
              size={16}
              className="text-ink-3 opacity-0 transition-opacity group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100"
            />
          )}
        </button>
      ) : (
        <>
          {children}
          {hidden}
        </>
      )}
    </th>
  );
}
