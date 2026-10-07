import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const labelVariants = cva("inline-flex items-center gap-1.5 text-ink peer-disabled:opacity-60", {
  variants: {
    size: {
      sm: "text-[12.5px] font-bold",
      md: "text-[14px] font-bold",
    },
  },
  defaultVariants: { size: "md" },
});

export type LabelProps = React.ComponentProps<"label"> & VariantProps<typeof labelVariants>;

/** Form label. Pair with a control through `htmlFor` (Field does this for you). Server-safe. */
export function Label({ className, size, ...props }: LabelProps) {
  // The control association is supplied by the caller through htmlFor or nesting.
  // eslint-disable-next-line jsx-a11y/label-has-associated-control
  return <label data-slot="label" className={cn(labelVariants({ size }), className)} {...props} />;
}

/** The small "Optional" tag shown after a label. */
export function OptionalTag({ className, children = "Optional", ...props }: React.ComponentProps<"span">) {
  return (
    <span className={cn("text-[12.5px] font-semibold text-ink-2", className)} {...props}>
      {children}
    </span>
  );
}
