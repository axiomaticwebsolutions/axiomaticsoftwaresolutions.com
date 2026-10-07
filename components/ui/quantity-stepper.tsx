"use client";

import type * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";

export type QuantityStepperProps = Omit<React.ComponentProps<"div">, "onChange" | "role"> & {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Accessible name of the group, e.g. "Terminals". Use aria-labelledby instead when a visible label exists. */
  label?: string;
  decrementLabel?: string;
  incrementLabel?: string;
  disabled?: boolean;
  size?: "sm" | "md";
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Minus / value / plus stepper (role="group"). The value is announced politely when it changes. At a bound the
 * button is aria-disabled rather than disabled, so keyboard focus is not lost. Arrow Up/Down, Home and End also
 * work on either button.
 */
export function QuantityStepper({
  value,
  onValueChange,
  min = 1,
  max = 10,
  step = 1,
  label,
  decrementLabel = "Decrease",
  incrementLabel = "Increase",
  disabled = false,
  size = "md",
  className,
  ...props
}: QuantityStepperProps) {
  const set = (next: number) => {
    const clamped = clamp(next, min, max);
    if (clamped !== value) onValueChange(clamped);
  };
  // Keys live on the buttons (interactive elements), so they work from either button.
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, number> = { ArrowUp: value + step, ArrowDown: value - step, Home: min, End: max };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    set(next);
  };
  const button = cn(
    "grid cursor-pointer place-items-center bg-surface text-ink transition-colors duration-150 hover:bg-lavender-soft hover:text-lavender-fg",
    "focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-surface",
    "aria-disabled:cursor-not-allowed aria-disabled:text-ink-3 aria-disabled:hover:bg-surface aria-disabled:hover:text-ink-3",
    size === "sm" ? "size-9" : "size-[38px]",
  );

  return (
    <div
      role="group"
      aria-label={label}
      data-slot="quantity-stepper"
      className={cn("inline-flex items-center overflow-hidden rounded-12 border border-line-input bg-surface", className)}
      {...props}
    >
      <button
        type="button"
        className={button}
        aria-label={decrementLabel}
        disabled={disabled}
        aria-disabled={value <= min || undefined}
        onClick={() => set(value - step)}
        onKeyDown={onKeyDown}
      >
        <Icon name="remove" size={size === "sm" ? 19 : 20} />
      </button>
      <span
        aria-live="polite"
        aria-atomic="true"
        className={cn("tabular text-center font-extrabold", size === "sm" ? "min-w-7" : "min-w-[30px]")}
      >
        {value}
      </span>
      <button
        type="button"
        className={button}
        aria-label={incrementLabel}
        disabled={disabled}
        aria-disabled={value >= max || undefined}
        onClick={() => set(value + step)}
        onKeyDown={onKeyDown}
      >
        <Icon name="add" size={size === "sm" ? 19 : 20} />
      </button>
    </div>
  );
}
