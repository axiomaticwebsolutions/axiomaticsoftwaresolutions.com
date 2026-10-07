import type * as React from "react";
import { deviceUsage } from "@/lib/admin/licenses/model";
import { cn } from "@/lib/utils";

/** Prototype two-line cell: a 13px/700 line (800 when `strong`) over a 12px/600 secondary line. Server-safe. */
export function TwoLine({ title, sub, strong = false, className }: { title: React.ReactNode; sub?: React.ReactNode; strong?: boolean; className?: string }) {
  return (
    <span className={cn("block min-w-0", className)}>
      <span className={cn("block break-words", strong ? "font-extrabold" : "font-bold")}>{title}</span>
      {sub ? <span className="block break-words text-[12px] font-semibold text-ink-2">{sub}</span> : null}
    </span>
  );
}

/** DEVICES cell (prototype bar): "n / limit" over a 5px bar, warn colour at the limit. */
export function DeviceUsageCell({ used, limit }: { used: number; limit: number }) {
  const usage = deviceUsage(used, limit);
  return (
    <span className="block min-w-[84px]">
      <span className="block font-bold tabular">{usage.label}</span>
      <span aria-hidden="true" className="mt-[5px] block h-[5px] w-full max-w-[110px] overflow-hidden rounded-pill bg-line-subtle forced-color-adjust-none">
        <span className={cn("block h-full", usage.full ? "bg-warn-bar" : "bg-primary")} style={{ width: `${usage.pct}%` }} />
      </span>
    </span>
  );
}
