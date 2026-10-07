import type * as React from "react";
import { DataTableStats, StatTile, type StatTone } from "@/components/data-table/stats";
import { cn } from "@/lib/utils";

export type { StatTone };

export type AdminStat = {
  /** Overline label, e.g. "Paid (all time)" (shown in capitals). */
  label: string;
  value: React.ReactNode;
  /** Small line under the value, e.g. "▲ 12% vs previous 30 days". */
  delta?: React.ReactNode;
  /** Colour of the value (prototype: paid sage, pending peach, failed pink...). */
  tone?: StatTone;
};

export type StatsRowProps = {
  stats: readonly AdminStat[];
  /** Accessible name of the list, e.g. "Order totals". */
  "aria-label"?: string;
  className?: string;
};

/**
 * Admin stats row (prototype `tb.stats`): cards that auto-fit at 170px minimum, radius 12, an 11px/800 overline and
 * a 20px/800 value in its semantic colour. A <dl>, so each label names its value. Server-safe.
 */
export function StatsRow({ stats, className, "aria-label": ariaLabel = "Summary" }: StatsRowProps) {
  if (stats.length === 0) return null;
  return (
    <DataTableStats variant="admin" aria-label={ariaLabel} className={cn("leading-[normal]", className)}>
      {stats.map((stat) => (
        <StatTile key={stat.label} variant="admin" label={stat.label} value={stat.value} tone={stat.tone} hint={stat.delta} />
      ))}
    </DataTableStats>
  );
}
