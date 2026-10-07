import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const spinnerVariants = cva(
  "inline-block shrink-0 animate-spin-fast rounded-pill border-2 border-solid motion-reduce:animate-none",
  {
    variants: {
      tone: {
        primary: "border-lavender-line border-t-primary",
        onPrimary: "border-white/35 border-t-white",
        current: "border-current/25 border-t-current",
      },
      size: {
        sm: "size-3.5",
        md: "size-4.5",
        lg: "size-6",
      },
    },
    defaultVariants: { tone: "primary", size: "md" },
  },
);

export type SpinnerProps = Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof spinnerVariants> & {
    /** Announced as a status when given; otherwise the spinner is decorative (e.g. inside a busy button). */
    label?: string;
  };

/** 0.8s linear ring spinner. Stops spinning under prefers-reduced-motion. */
export function Spinner({ tone, size, label, className, ...props }: SpinnerProps) {
  const ring = <span aria-hidden="true" className={cn(spinnerVariants({ tone, size }), !label && className)} {...(label ? {} : props)} />;
  if (!label) return ring;
  return (
    <span role="status" data-slot="spinner" className={cn("inline-flex items-center", className)} {...props}>
      {ring}
      <span className="sr-only">{label}</span>
    </span>
  );
}
