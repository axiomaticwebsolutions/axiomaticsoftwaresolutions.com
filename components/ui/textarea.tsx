import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const textareaVariants = cva(
  [
    "block w-full min-w-0 resize-y border border-line-input bg-surface text-ink leading-normal",
    "focus-visible:border-primary focus-visible:shadow-focus focus-visible:outline-hidden",
    "transition-[border-color,box-shadow] duration-150 placeholder:text-ink-3",
    "disabled:cursor-not-allowed disabled:bg-line-subtle disabled:text-ink-2",
    "aria-invalid:border-danger-border aria-invalid:focus-visible:border-danger-border",
  ],
  {
    variants: {
      size: {
        sm: "min-h-16 rounded-8 px-2.5 py-2 text-[13.5px]",
        md: "min-h-28 rounded-10 px-3.5 py-3 text-[15px]",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export type TextareaProps = React.ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>;

export function Textarea({ className, size, ...props }: TextareaProps) {
  return <textarea data-slot="textarea" className={cn(textareaVariants({ size }), className)} {...props} />;
}
