"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VARIANT_STYLES } from "@/components/data-table/styles";
import type { DataTableVariant } from "@/components/data-table/types";

export type BulkBarProps = {
  /** Number of selected rows; the bar shows while it is above 0. */
  count: number;
  onClear: () => void;
  clearLabel?: string;
  variant?: DataTableVariant;
  className?: string;
  children?: React.ReactNode;
};

/**
 * Lavender bar above the table while rows are selected: "{n} selected", the bulk actions and Clear. A polite live
 * region that stays mounted announces "3 selected" and "Selection cleared" to screen readers.
 */
export function BulkBar({ count, onClear, clearLabel = "Clear", variant = "portal", className, children }: BulkBarProps) {
  const styles = VARIANT_STYLES[variant];
  const [announcement, setAnnouncement] = React.useState("");
  const [lastCount, setLastCount] = React.useState(count);
  if (count !== lastCount) {
    setLastCount(count);
    setAnnouncement(count > 0 ? `${count} selected` : "Selection cleared");
  }

  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      {count > 0 ? (
        <div
          role="group"
          aria-label="Bulk actions"
          data-slot="data-table-bulk-bar"
          className={cn(
            "flex flex-wrap items-center gap-2 border-b border-lavender-line bg-lavender-soft font-bold text-ink",
            styles.bulkBar,
            className,
          )}
        >
          <span>{count.toLocaleString("en-IN")} selected</span>
          {children}
          <button
            type="button"
            onClick={onClear}
            className="ml-auto cursor-pointer rounded-6 font-bold text-primary-link hover:text-primary-link-hover hover:underline"
          >
            {clearLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}

export type BulkActionProps = Omit<ButtonProps, "variant" | "size"> & {
  /** primary (Renew selected), outline (Export selected) or danger (Deactivate selected). */
  tone?: "primary" | "outline" | "danger";
  variant?: DataTableVariant;
  /** Unavailable with a reason (tooltip), e.g. "Requires Owner or Billing admin". The button stays focusable. */
  disabledReason?: string;
};

const TONE_TO_VARIANT = { primary: "primary", outline: "secondary", danger: "destructive-outline" } as const;

/** A button for the bulk bar, sized like the prototype's (6px 12px, radius 9). */
export function BulkAction({ tone = "outline", variant = "portal", disabledReason, className, onClick, ...props }: BulkActionProps) {
  const button = (
    <Button
      type="button"
      variant={TONE_TO_VARIANT[tone]}
      className={cn(VARIANT_STYLES[variant].bulkButton, className)}
      aria-disabled={disabledReason ? true : undefined}
      onClick={disabledReason ? (event) => event.preventDefault() : onClick}
      {...props}
    />
  );
  if (!disabledReason) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  );
}
