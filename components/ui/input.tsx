import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Shared look for text-like controls (Input, NativeSelect, Select trigger). */
export const controlVariants = cva(
  [
    "w-full min-w-0 border border-line-input bg-surface text-ink transition-[border-color,box-shadow] duration-150",
    // Utilities, not a component class, so they beat border-line-input (README > Focus: primary border + 4px ring).
    "focus-visible:border-primary focus-visible:shadow-focus focus-visible:outline-hidden",
    "placeholder:text-ink-3 disabled:cursor-not-allowed disabled:bg-line-subtle disabled:text-ink-2",
    "aria-invalid:border-danger-border aria-invalid:focus-visible:border-danger-border",
  ],
  {
    variants: {
      size: {
        sm: "h-9 rounded-8 px-2.5 text-[13.5px]",
        md: "h-12 rounded-10 px-3.5 text-[15px]",
        lg: "h-[50px] rounded-14 px-4 text-base",
      },
      mono: {
        true: "font-mono tracking-[0.02em]",
        false: "",
      },
    },
    defaultVariants: { size: "md", mono: false },
  },
);

export type ControlSize = NonNullable<VariantProps<typeof controlVariants>["size"]>;

export type InputProps = Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof controlVariants>;

/** Text input. sm = admin (36px, radius 8), md = forms (48px, radius 10), lg = search/checkout (50px, radius 14). */
export function Input({ className, size, mono, type = "text", ...props }: InputProps) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(controlVariants({ size, mono }), "read-only:bg-bg", className)}
      {...props}
    />
  );
}
