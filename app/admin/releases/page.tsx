import { Suspense } from "react";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage } from "@/components/admin/module-page";
import { ReleasesActions, ReleasesView } from "@/components/admin/catalog/releases-view";
import { CatalogTableSkeleton } from "@/components/admin/catalog/table-skeleton";
import { catalogQueryFromState, RELEASE_DEFAULT_SORT, RELEASE_SORTS, RELEASES_LIST } from "@/lib/admin/catalog/list-config";
import { catalogFormOptions } from "@/lib/admin/catalog/products";
import { listReleases } from "@/lib/admin/catalog/releases";
import { downloadTtlSeconds, getSetting } from "@/lib/config";
import { db } from "@/lib/db";
import { parseListState, type SearchParamsInput } from "@/lib/url-state";

export const metadata = adminPageMetadata("releases");

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function ReleasesData({ searchParams }: { searchParams: SearchParams }) {
  const state = parseListState((await searchParams) as SearchParamsInput, RELEASES_LIST);
  const query = catalogQueryFromState(state, RELEASE_SORTS, RELEASE_DEFAULT_SORT);
  const [page, options, licensing] = await Promise.all([listReleases(query), catalogFormOptions(), getSetting(db, "licensing")]);
  const linkMinutes = Math.max(1, Math.floor(downloadTtlSeconds({ licensing }) / 60));
  return <ReleasesView page={page} options={options} linkMinutes={linkMinutes} />;
}

/** Admin > Catalog > Software releases (Admin Console.dc.html #releases). Every staff role can view it. */
export default function AdminReleasesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AdminModulePage
      moduleKey="releases"
      actions={
        <Suspense>
          <ReleasesActions />
        </Suspense>
      }
    >
      <Suspense fallback={<CatalogTableSkeleton />}>
        <ReleasesData searchParams={searchParams} />
      </Suspense>
    </AdminModulePage>
  );
}
