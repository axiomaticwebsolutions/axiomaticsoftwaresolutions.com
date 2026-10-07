/**
 * /admin/licenses (Admin Console.dc.html #licenses): stats, the server-paged licenses table for the URL state
 * (?q=&filter[status|product|devices]=&sort=&page=), the license drawer (?id=) and "Issue license". Every staff role
 * can open it; actions are gated per permission (Finance reads only).
 */
import { Suspense } from "react";
import { unstable_rethrow } from "next/navigation";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage, type AdminStat } from "@/components/admin/module-page";
import { IssueLicenseAction } from "@/components/admin/licenses/issue-license";
import { LicensesView } from "@/components/admin/licenses/licenses-view";
import { getAdminState } from "@/lib/admin/context";
import { listQueryFromSearchParams } from "@/lib/admin/licenses/list-state";
import { LICENSE_DEFAULT_SORT, LICENSES_LIST, type AdminLicenseStats } from "@/lib/admin/licenses/model";
import { adminLicenseStats, adminProductOptions, listAdminLicenses, manualIssuePlanOptions, type AdminLicenseList } from "@/lib/admin/licenses/queries";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

export const metadata = adminPageMetadata("licenses");

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function statsOf(s: AdminLicenseStats): AdminStat[] {
  const n = (v: number) => v.toLocaleString("en-IN");
  return [
    { label: "Active", value: n(s.active), tone: "sage" },
    { label: "Expiring \u2264 60 days", value: n(s.expiring), tone: "peach" },
    { label: "Devices in use", value: n(s.devicesInUse) },
    { label: "Suspended / revoked", value: n(s.suspendedOrRevoked), tone: "pink" },
  ];
}

export default async function AdminLicensesPage({ searchParams }: PageProps) {
  const state = await getAdminState();
  // Inactive staff get the layout's notice; locked roles get the module's permission-denied page (nothing loaded).
  if (state.kind !== "ready") return null;
  const ctx = state.context;
  if (!ctx.canView("licenses")) return <AdminModulePage moduleKey="licenses" />;
  const query = listQueryFromSearchParams(await searchParams, LICENSES_LIST, LICENSE_DEFAULT_SORT);
  const now = new Date();
  let data: AdminLicenseList | null = null;
  let stats: AdminLicenseStats | null = null;
  let products: Awaited<ReturnType<typeof adminProductOptions>> = [];
  let plans: Awaited<ReturnType<typeof manualIssuePlanOptions>> = [];
  try {
    [data, stats, products, plans] = await Promise.all([
      listAdminLicenses(db, query, now),
      adminLicenseStats(db, now),
      adminProductOptions(db),
      ctx.can("licenses.manage") ? manualIssuePlanOptions(db) : Promise.resolve([]),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    log.warn("admin_licenses_unavailable", { error: error instanceof Error ? error.message : String(error) });
  }
  return (
    <AdminModulePage moduleKey="licenses" stats={stats ? statsOf(stats) : undefined} actions={<IssueLicenseAction plans={plans} />}>
      <Suspense>
        <LicensesView data={data} products={products} nowIso={now.toISOString()} />
      </Suspense>
    </AdminModulePage>
  );
}
