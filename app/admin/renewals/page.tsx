/**
 * /admin/renewals (Admin Console.dc.html #renewals; customers.view): licenses ending in the next 60 days or ended in
 * the last 30, with the stats row, the Window filter, "Send reminder now" (renewals.remind) and the license drawer.
 */
import { Suspense } from "react";
import { unstable_rethrow } from "next/navigation";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage, type AdminStat } from "@/components/admin/module-page";
import { RenewalsView } from "@/components/admin/renewals/renewals-view";
import { getAdminState } from "@/lib/admin/context";
import { listQueryFromSearchParams } from "@/lib/admin/licenses/list-state";
import { RENEWAL_DEFAULT_SORT, RENEWALS_LIST, type AdminRenewalStats } from "@/lib/admin/renewals/model";
import { adminRenewalStats, listAdminRenewals, type AdminRenewalList } from "@/lib/admin/renewals/queries";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { formatINR } from "@/lib/money";

export const metadata = adminPageMetadata("renewals");

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function statsOf(s: AdminRenewalStats): AdminStat[] {
  const n = (v: number) => v.toLocaleString("en-IN");
  return [
    { label: "Due \u2264 30 days", value: n(s.dueSoon), tone: "peach" },
    { label: "Due 31\u201360 days", value: n(s.dueLater) },
    { label: "Lapsed (30 days)", value: n(s.lapsed), tone: "pink" },
    // Prototype m0(): whole rupees, excluding GST.
    { label: "Renewal value", value: formatINR(Math.round(s.valuePaise / 100) * 100), tone: "sage" },
  ];
}

export default async function AdminRenewalsPage({ searchParams }: PageProps) {
  const state = await getAdminState();
  if (state.kind !== "ready") return null;
  if (!state.context.canView("renewals")) return <AdminModulePage moduleKey="renewals" />;
  const query = listQueryFromSearchParams(await searchParams, RENEWALS_LIST, RENEWAL_DEFAULT_SORT);
  const now = new Date();
  let data: AdminRenewalList | null = null;
  let stats: AdminRenewalStats | null = null;
  try {
    [data, stats] = await Promise.all([listAdminRenewals(db, query, now), adminRenewalStats(db, now)]);
  } catch (error) {
    unstable_rethrow(error);
    log.warn("admin_renewals_unavailable", { error: error instanceof Error ? error.message : String(error) });
  }
  return (
    <AdminModulePage moduleKey="renewals" stats={stats ? statsOf(stats) : undefined}>
      <Suspense>
        <RenewalsView data={data} />
      </Suspense>
    </AdminModulePage>
  );
}
