"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/account/page-header";
import { pageTitleForPath } from "@/components/account/page-title";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Portal loading state (prototype): the page keeps its own title ("Support tickets", "Devices"), then four 104px
 * tiles and a 280px block pulsing in the skeleton grey. Pages titled by their data (a license, a ticket) show a
 * heading-sized skeleton instead of a heading that would change. Shown while a portal page streams in.
 */
export default function AccountLoading() {
  const pathname = usePathname();
  return (
    <div aria-busy="true">
      <PageHeader title={pageTitleForPath(pathname)} />
      <span role="status" className="sr-only">
        Loading
      </span>
      <div className="grid gap-3.5">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} alt className="h-[104px] rounded-16" />
          ))}
        </div>
        <Skeleton alt className="h-[280px] rounded-16" />
      </div>
    </div>
  );
}
