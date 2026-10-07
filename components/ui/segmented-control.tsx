"use client";

import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const trackVariants = cva("inline-flex max-w-full flex-wrap items-center", {
  variants: {
    variant: {
      // Storefront price toggle: white track, lavender selected (README > Price display).
      lavender: "gap-0.5 rounded-12 border border-line bg-surface p-1",
      // Portal and admin filters: slate track, white selected chip with a shadow.
      chip: "gap-0.5 rounded-10 bg-slate-bg p-[3px]",
    },
  },
  defaultVariants: { variant: "lavender" },
});

const optionVariants = cva(
  "inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap font-bold transition-[background-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        lavender:
          "rounded-9 px-3 py-2 text-[13.5px] text-ink-2 hover:text-ink aria-pressed:bg-lavender-bg aria-pressed:text-lavender-fg",
        chip: "rounded-8 px-2.5 py-1.5 text-[13px] text-ink-2 hover:text-ink aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-tile",
      },
    },
    defaultVariants: { variant: "lavender" },
  },
);

export type SegmentedOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
};

export type SegmentedControlProps<T extends string> = Omit<React.ComponentProps<"div">, "onChange" | "role"> &
  VariantProps<typeof trackVariants> & {
    options: readonly SegmentedOption<T>[];
    value: T;
    onValueChange: (value: T) => void;
  } & ({ "aria-label": string } | { "aria-labelledby": string });

/**
 * Exclusive choice as a group of toggle buttons (role="group", aria-pressed), e.g. Excl./Incl. GST,
 * date ranges and status filters. Each option is a tab stop, matching the prototypes.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  variant,
  className,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <div role="group" data-slot="segmented-control" className={cn(trackVariants({ variant }), className)} {...props}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          className={optionVariants({ variant })}
          onClick={() => {
            if (option.value !== value) onValueChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
