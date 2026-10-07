import type * as React from "react";
import { cn } from "@/lib/utils";
import { VARIANT_STYLES } from "@/components/data-table/styles";
import type { DataTableVariant } from "@/components/data-table/types";

export type StatTone = "default" | "sage" | "peach" | "pink" | "lavender" | "blue";

const TONE_TEXT: Record<StatTone, string> = {
  default: "text-ink",
  sage: "text-sage-fg",
  peach: "text-peach-fg",
  pink: "text-pink-fg",
  lavender: "text-lavender-fg",
  blue: "text-blue-fg",
};

/** Stats row above a table (Devices: ACTIVE DEVICES, FREE SLOTS...; admin modules: PAID, PENDING...). A <dl>. */
export function DataTableStats({
  variant = "portal",
  className,
  children,
  "aria-label": ariaLabel,
}: {
  variant?: DataTableVariant;
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
}) {
  return (
    <dl aria-label={ariaLabel} className={cn("grid", VARIANT_STYLES[variant].statGrid, className)}>
      {children}
    </dl>
  );
}

/** One stat: overline label and a large value, optionally coloured (FREE SLOTS in sage, INACTIVE in peach). */
export function StatTile({
  label,
  value,
  tone = "default",
  hint,
  variant = "portal",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: StatTone;
  /** Small line under the value. */
  hint?: React.ReactNode;
  variant?: DataTableVariant;
  className?: string;
}) {
  const styles = VARIANT_STYLES[variant];
  return (
    <div className={cn("min-w-0 border border-line-alt bg-surface", styles.stat, className)}>
      <dt className={cn("font-extrabold uppercase text-ink-2", styles.statLabel)}>{label}</dt>
      <dd className={cn("font-extrabold leading-tight tabular", styles.statValue, TONE_TEXT[tone])}>{value}</dd>
      {hint ? <dd className="mt-0.5 text-[12.5px] font-semibold text-ink-2">{hint}</dd> : null}
    </div>
  );
}
