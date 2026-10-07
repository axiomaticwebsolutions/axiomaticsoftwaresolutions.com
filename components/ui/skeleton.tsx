import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Loading placeholder: skeleton grey pulsing opacity .55-1 over 1.4s (README > Loading); static under
 * prefers-reduced-motion. Decorative; mark the loading region with aria-busy and a visually hidden "Loading".
 */
export function Skeleton({ className, alt = false, ...props }: React.ComponentProps<"div"> & { alt?: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn("skeleton motion-reduce:animate-none", alt && "bg-skeleton-alt", className)}
      {...props}
    />
  );
}
