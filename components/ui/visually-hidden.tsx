import type * as React from "react";
import { cn } from "@/lib/utils";

/** Text for screen readers only (the `sr-only` pattern). Server-safe. */
export function VisuallyHidden({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="visually-hidden" className={cn("sr-only", className)} {...props} />;
}
