import type * as React from "react";
import { cn } from "@/lib/utils";

/** Keyboard key hint, e.g. <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>. Server-safe. */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-6 border border-line-strong border-b-2 bg-surface px-1.5",
        "font-mono text-[11.5px] font-semibold leading-none text-ink-2",
        className,
      )}
      {...props}
    />
  );
}
