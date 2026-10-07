"use client";

import { usePathname } from "next/navigation";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { moduleKeyForPath } from "@/components/admin/admin-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { adminGroupTitle, adminModule } from "@/lib/rbac";

/**
 * Admin loading state (prototype): the module keeps its breadcrumb, title and description while four 96px tiles and
 * a 320px block pulse in the skeleton grey (radius 14). Unknown paths show a heading-sized skeleton instead.
 */
export function AdminPageSkeleton() {
  const pathname = usePathname();
  const key = moduleKeyForPath(pathname);
  const mod = key ? adminModule(key) : null;
  return (
    <div aria-busy="true">
      <AdminPageHeader
        group={mod ? adminGroupTitle(mod.group) : undefined}
        title={mod ? mod.title : null}
        description={mod?.description}
      />
      <span role="status" className="sr-only">
        Loading
      </span>
      <div className="grid gap-3">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} alt className="h-24 rounded-14" />
          ))}
        </div>
        <Skeleton alt className="h-80 rounded-14" />
      </div>
    </div>
  );
}
