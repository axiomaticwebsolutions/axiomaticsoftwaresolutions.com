import { Skeleton } from "@/components/ui/skeleton";

/** Loading state of a catalog table while its rows stream in (prototype skeleton grey, radius 14). Server-safe. */
export function CatalogTableSkeleton() {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        Loading
      </span>
      <Skeleton alt className="h-80 rounded-14" />
    </div>
  );
}
