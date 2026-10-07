import type * as React from "react";
import { cn } from "@/lib/utils";

export type ProductSectionProps = Omit<React.ComponentProps<"section">, "aria-labelledby"> & {
  /** Anchor id (in-page nav target); omit for sections outside the nav. */
  id?: string;
  /** Id of the section's heading. */
  labelledBy: string;
  /** Top divider (every section after Features). */
  divider?: boolean;
};

/**
 * Product page section: vertical rhythm clamp(48px,6vw,80px), optional top divider, and an anchor offset that clears
 * the sticky header plus the in-page nav (prototype: scroll-margin-top 180px = 108 + 54 + 18). <html> already has
 * scroll-padding-top = header + in-page nav (--store-sticky-extra, once measured) + 12px (globals.css), so the margin
 * is the rest of 72px: the total stays header + 72px before and after the nav is measured. Server-safe.
 */
export function ProductSection({ id, labelledBy, divider = true, className, ...props }: ProductSectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn(
        "scroll-mt-[calc(60px-var(--store-sticky-extra,0px))] py-[clamp(48px,6vw,80px)]",
        divider && "border-t border-line",
        className,
      )}
      {...props}
    />
  );
}
