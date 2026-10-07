import { Skeleton } from "@/components/ui/skeleton";

const GROUP_ROWS = [4, 4, 3, 5] as const;

/** One pulsing placeholder card (Software.dc.html skeleton: 140px header, three bars and a button bar). */
function SkeletonCard() {
  return (
    <div
      aria-hidden="true"
      className="animate-skeleton overflow-hidden rounded-22 border border-line bg-surface motion-reduce:animate-none"
    >
      <div className="h-[140px] bg-slate-bg" />
      <div className="grid gap-3 p-[22px]">
        <div className="h-3 w-[40%] rounded-6 bg-skeleton" />
        <div className="h-[18px] w-[80%] rounded-6 bg-skeleton" />
        <div className="h-3 w-[95%] rounded-6 bg-skeleton" />
        <div className="mt-3 h-10 rounded-12 bg-skeleton" />
      </div>
    </div>
  );
}

/**
 * Loading state for /software below the intro: toolbar and sidebar placeholders, "Loading software…" and four skeleton
 * cards. Server-safe.
 */
export function CatalogSkeleton() {
  return (
    <div aria-busy="true">
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <Skeleton className="h-[50px] flex-[1_1_320px] rounded-14" />
        <Skeleton className="h-[50px] w-[120px] rounded-14 catalog:hidden" />
        <Skeleton className="h-[50px] w-[210px] rounded-14" />
      </div>
      <div className="mt-6 grid items-start gap-8 catalog:grid-cols-[240px_minmax(0,1fr)]">
        <div aria-hidden="true" className="hidden catalog:block">
          {GROUP_ROWS.map((rows, group) => (
            <div key={group} className="grid gap-3 border-b border-line py-[18px]">
              <Skeleton className="h-3.5 w-[60%] rounded-6" />
              {Array.from({ length: rows }, (_, row) => (
                <Skeleton key={row} className="h-[18px] rounded-6" />
              ))}
            </div>
          ))}
        </div>
        <div className="min-w-0">
          <div className="flex min-h-[34px] items-center">
            <p role="status" className="m-0 text-[14.5px] font-bold text-ink-2">
              Loading software…
            </p>
          </div>
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-5">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
