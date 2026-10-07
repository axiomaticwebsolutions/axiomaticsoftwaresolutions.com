import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

const WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-2/5", "w-3/5"] as const;

/**
 * Placeholder rows while a table loads (README > Loading: skeleton grey pulsing .55-1 over 1.4s). Decorative: the
 * table carries aria-busy and a visually hidden "Loading" row.
 */
export function SkeletonRows({
  columns,
  rows = 5,
  leadingCheckbox = false,
  trailingCell = false,
  cellClassName,
}: {
  /** Data columns (the selection and open columns are added through the flags). */
  columns: number;
  rows?: number;
  leadingCheckbox?: boolean;
  trailingCell?: boolean;
  cellClassName?: string;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true" className="border-t border-line-subtle">
          {leadingCheckbox ? (
            <td className={cn(cellClassName, "w-9")}>
              <Skeleton className="size-[18px] rounded-[5px]" />
            </td>
          ) : null}
          {Array.from({ length: columns }, (_, c) => (
            <td key={c} className={cellClassName}>
              {c === 0 ? (
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-8 shrink-0 rounded-9" />
                  <div className="grid flex-1 gap-1.5">
                    <Skeleton className="h-3.5 w-4/5" />
                    <Skeleton alt className="h-3 w-1/2" />
                  </div>
                </div>
              ) : (
                <Skeleton className={cn("h-3.5", WIDTHS[(r + c) % WIDTHS.length])} />
              )}
            </td>
          ))}
          {trailingCell ? <td className={cellClassName} /> : null}
        </tr>
      ))}
    </>
  );
}

/** Placeholder mobile cards. */
export function SkeletonCards({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <li key={r} aria-hidden="true" className={cn("grid gap-2.5", className)}>
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-8 shrink-0 rounded-9" />
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton alt className="h-3 w-2/5" />
            </div>
            <Skeleton className="h-5 w-16 rounded-pill" />
          </div>
          <div className="flex justify-between">
            <Skeleton alt className="h-3 w-1/3" />
            <Skeleton alt className="h-3 w-10" />
          </div>
        </li>
      ))}
    </>
  );
}
