"use client";

import type * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/** Radio group (arrow keys move the selection). Give it an accessible name with aria-label(ledby) or a fieldset. */
export function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-2.5", className)} {...props} />;
}

export function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "peer grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-pill border-[1.5px] border-line-control bg-surface",
        "transition-[border-color] duration-150 hover:border-primary data-[state=checked]:border-primary",
        "aria-invalid:border-danger-border disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {/* Forced colours drop backgrounds: the dot uses the system text colour there. */}
      <RadioGroupPrimitive.Indicator className="block size-2.5 rounded-pill bg-primary forced-colors:bg-[color:CanvasText]" />
    </RadioGroupPrimitive.Item>
  );
}
