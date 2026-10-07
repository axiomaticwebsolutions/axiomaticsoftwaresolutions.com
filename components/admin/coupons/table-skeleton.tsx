import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder while a module table hydrates (Suspense fallback around components that read the URL). Server-safe. */
export function PageSkeletonTable() {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        Loading
      </span>
      <Skeleton alt className="h-80 rounded-14" />
    </div>
  );
}
