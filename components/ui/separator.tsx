import type * as React from "react";
import { cn } from "@/lib/utils";

export type SeparatorProps = React.ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical";
  /** Purely visual (default). Set false when the line separates content semantically. */
  decorative?: boolean;
};

/** Hairline divider. Server-safe. */
export function Separator({ className, orientation = "horizontal", decorative = true, ...props }: SeparatorProps) {
  const a11y = decorative
    ? ({ role: "none" } as const)
    : ({ role: "separator", "aria-orientation": orientation } as const);
  return (
    <div
      data-slot="separator"
      data-orientation={orientation}
      className={cn("shrink-0 bg-line", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
      {...a11y}
      {...props}
    />
  );
}
