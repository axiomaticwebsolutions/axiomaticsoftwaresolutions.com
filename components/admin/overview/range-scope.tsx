"use client";

import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DEFAULT_RANGE, RANGE_KEYS, RANGE_META, type RangeKey } from "@/lib/admin/overview/range";
import { cn } from "@/lib/utils";

const RANGE_OPTIONS = RANGE_KEYS.map((key) => ({ value: key, label: RANGE_META[key].label }));

/** The page URL for a range: the default (30 days) is left out ("/admin", "/admin?range=7d"). */
export function rangeHref(pathname: string, range: RangeKey): string {
  return range === DEFAULT_RANGE ? pathname : `${pathname}?range=${range}`;
}

export type RangeScopeProps = {
  range: RangeKey;
  /** Right side of the toolbar (prototype: "Sample data · amounts exclude GST unless noted"). */
  note?: React.ReactNode;
  className?: string;
  /** Range-dependent content, rendered on the server for `range`. */
  children: React.ReactNode;
};

/**
 * Date range toolbar of the Overview and Reports (prototype: a segmented "Date range" group of 7 days, 30 days,
 * 90 days and 12 months, plus the note). Choosing a range replaces `?range=` in the URL, so the server renders the
 * page for it; until it arrives the old figures stay, dimmed and marked busy.
 */
export function RangeScope({ range, note, className, children }: RangeScopeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = React.useTransition();
  // The pressed button follows the click at once; the URL (and so `range`) catches up when the page arrives.
  const [shown, setShown] = React.useOptimistic(range);

  const choose = (next: RangeKey) => {
    startTransition(() => {
      setShown(next);
      router.replace(rangeHref(pathname, next), { scroll: false });
    });
  };

  return (
    <div className={cn("grid min-w-0 gap-3.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <SegmentedControl
          variant="chip"
          aria-label="Date range"
          options={RANGE_OPTIONS}
          value={shown}
          onValueChange={choose}
          className="rounded-9 [&>button]:px-3"
        />
        {note ? <span className="text-[12.5px] font-semibold text-ink-2">{note}</span> : null}
      </div>
      <div aria-busy={pending || undefined} className={cn("grid min-w-0 gap-3.5 transition-opacity duration-150", pending && "opacity-60")}>
        {children}
      </div>
    </div>
  );
}
