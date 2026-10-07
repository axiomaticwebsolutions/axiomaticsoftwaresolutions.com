import { Suspense } from "react";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage } from "@/components/admin/module-page";
import { PlansActions, PlansView } from "@/components/admin/catalog/plans-view";
import { CatalogTableSkeleton } from "@/components/admin/catalog/table-skeleton";
import { catalogQueryFromState, PLAN_DEFAULT_SORT, PLAN_SORTS, PLANS_LIST } from "@/lib/admin/catalog/list-config";
import { listPlans } from "@/lib/admin/catalog/plans";
import { catalogFormOptions } from "@/lib/admin/catalog/products";
import { getSetting } from "@/lib/config";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { parseListState, type SearchParamsInput } from "@/lib/url-state";

export const metadata = adminPageMetadata("plans");

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function PlansData({ searchParams }: { searchParams: SearchParams }) {
  const state = parseListState((await searchParams) as SearchParamsInput, PLANS_LIST);
  const query = catalogQueryFromState(state, PLAN_SORTS, PLAN_DEFAULT_SORT);
  const [page, options, tax] = await Promise.all([listPlans(query), catalogFormOptions(), getSetting(db, "tax")]);
  return <PlansView page={page} options={options} gstRatePct={tax.gstRatePct} offlineGraceDays={getEnv().LICENSE_OFFLINE_GRACE_DAYS} />;
}

/** Admin > Catalog > Plans & license policies (Admin Console.dc.html #plans). Every staff role can view it. */
export default function AdminPlansPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AdminModulePage
      moduleKey="plans"
      actions={
        <Suspense>
          <PlansActions />
        </Suspense>
      }
    >
      <Suspense fallback={<CatalogTableSkeleton />}>
        <PlansData searchParams={searchParams} />
      </Suspense>
    </AdminModulePage>
  );
}
