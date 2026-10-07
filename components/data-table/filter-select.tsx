"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import type { DataTableOption, DataTableVariant } from "@/components/data-table/types";
import { VARIANT_STYLES } from "@/components/data-table/styles";

export type FilterSelectProps = Omit<React.ComponentProps<"select">, "onChange" | "value" | "size"> & {
  /** Visible label before the select; it is also the select's accessible name. */
  label: string;
  options: readonly DataTableOption[];
  value: string;
  onValueChange: (value: string) => void;
  variant?: DataTableVariant;
  /** Hide the visible label (the accessible name stays). */
  hideLabel?: boolean;
  labelClassName?: string;
};

/** Toolbar filter: "Status [All v]" as a native select (fast and accessible on phones), wrapped in its label. */
export function FilterSelect({
  label,
  options,
  value,
  onValueChange,
  variant = "portal",
  hideLabel = false,
  className,
  labelClassName,
  ...props
}: FilterSelectProps) {
  const styles = VARIANT_STYLES[variant];
  return (
    <label
      data-slot="filter-select"
      className={cn("flex min-w-0 max-w-full items-center gap-1.5 font-bold text-ink-2", styles.filterLabel, labelClassName)}
    >
      <span className={cn("whitespace-nowrap", hideLabel && "sr-only")}>{label}</span>
      <span className="relative min-w-0">
        <select
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          className={cn(
            "max-w-full cursor-pointer appearance-none truncate border border-line-strong bg-surface pl-2.5 pr-8 font-bold text-ink",
            "transition-[border-color,box-shadow] duration-150 hover:border-line-input field-focus",
            "disabled:cursor-not-allowed disabled:bg-line-subtle disabled:text-ink-2",
            styles.control,
            className,
          )}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon
          name="expand_more"
          size={18}
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-3"
        />
      </span>
    </label>
  );
}
