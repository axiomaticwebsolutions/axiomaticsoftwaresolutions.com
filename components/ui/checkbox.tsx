"use client";

import type * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";

/**
 * 18px checkbox (role="checkbox", Space toggles); size "sm" is 16px (portal table rows, as the prototype's native
 * checkboxes). Supports `checked="indeterminate"` for page-scoped select-all.
 */
export function Checkbox({
  className,
  size = "md",
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & { size?: "sm" | "md" }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer grid shrink-0 cursor-pointer place-items-center border-[1.5px] border-line-control bg-surface text-white",
        size === "sm" ? "size-4 rounded-[4px]" : "size-[18px] rounded-[5px]",
        "transition-[background-color,border-color] duration-150 hover:border-primary",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
        "aria-invalid:border-danger-border disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        {props.checked === "indeterminate" ? (
          <Icon name="remove" size={size === "sm" ? 14 : 16} />
        ) : (
          <Icon name="check" size={size === "sm" ? 14 : 16} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
