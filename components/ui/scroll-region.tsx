"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type ScrollRegionProps = Omit<React.ComponentProps<"div">, "role" | "tabIndex" | "aria-label" | "aria-labelledby"> & {
  /** id of the visible title that names the region while it scrolls (preferred). */
  labelledBy?: string;
  /** Name of the region while it scrolls when there is no visible title (default "Table"). */
  label?: string;
};

/**
 * Horizontal scroll container for wide content (tables, matrices). The page itself never scrolls sideways (WCAG
 * 1.4.10): at 400% zoom, with larger text spacing (1.4.12) or on a narrow panel the content scrolls in here instead.
 * While it overflows it is a named, focusable region, so keyboard users can scroll it with the arrow keys (WCAG 2.1.1;
 * axe scrollable-region-focusable); otherwise it is a plain div and adds no Tab stop.
 */
export function ScrollRegion({ labelledBy, label = "Table", className, children, ...props }: ScrollRegionProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = React.useState(false);
  React.useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const check = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      data-slot="scroll-region"
      role={overflowing ? "region" : undefined}
      aria-labelledby={overflowing ? labelledBy : undefined}
      aria-label={overflowing && !labelledBy ? label : undefined}
      // Focusable only while it scrolls (see above).
      tabIndex={overflowing ? 0 : undefined}
      className={cn("relative overflow-x-auto focus-visible:-outline-offset-2", className)}
      {...props}
    >
      {children}
    </div>
  );
}
