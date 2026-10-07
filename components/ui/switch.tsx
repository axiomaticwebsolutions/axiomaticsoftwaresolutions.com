"use client";

import type * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * 42x24 switch (role="switch"); track primary when on, line-control when off (3.7:1 against the page and the white
 * thumb, WCAG 1.4.11). Label it with aria-labelledby or a <Label htmlFor>. In forced colours (Windows contrast themes)
 * the browser would drop both backgrounds and the switch would vanish: it gets an outlined track and system colours
 * (Highlight track when on).
 */
export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-6 w-[42px] shrink-0 cursor-pointer items-center rounded-pill bg-line-control transition-colors duration-150",
        "data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
        "forced-colors:border forced-colors:border-[color:CanvasText] forced-colors:bg-[color:Canvas] forced-colors:data-[state=checked]:bg-[color:Highlight]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[18px] translate-x-[3px] rounded-pill bg-white shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-[21px] forced-colors:translate-x-[2px] forced-colors:data-[state=checked]:translate-x-[20px] forced-colors:bg-[color:CanvasText] forced-colors:data-[state=checked]:bg-[color:HighlightText]"
      />
    </SwitchPrimitive.Root>
  );
}
