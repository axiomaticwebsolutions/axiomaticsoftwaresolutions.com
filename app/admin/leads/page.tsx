import { Suspense } from "react";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { PageSkeletonTable } from "@/components/admin/coupons/table-skeleton";
import { LeadsView } from "@/components/admin/leads/leads-view";
import { AdminModulePage, type AdminStat } from "@/components/admin/module-page";
import { getAdminState } from "@/lib/admin/context";
import { LEAD_LIST_SPEC } from "@/lib/admin/leads/model";
import { leadStats, listLeads } from "@/lib/admin/leads/service";
import { parseListQuery } from "@/lib/admin/list-query";
import { db } from "@/lib/db";

export const metadata = adminPageMetadata("leads");

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.append(key, value);
    else if (Array.isArray(value)) for (const v of value) params.append(key, v);
  }
  return params;
}

/** Admin > Contact & demo requests (Leads; leads.view: Owner, Administrator, Support). */
export default async function AdminLeadsPage({ searchParams }: { searchParams: SearchParams }) {
  const state = await getAdminState();
  // Nothing is loaded for roles that cannot open the module (AdminModulePage then shows the locked page).
  const allowed = state.kind === "ready" && state.context.canView("leads");
  let stats: AdminStat[] | undefined;
  let body: React.ReactNode = null;
  if (allowed) {
    const query = parseListQuery(toSearchParams(await searchParams), LEAD_LIST_SPEC);
    const [page, counts] = await Promise.all([listLeads(query, db), leadStats(db)]);
    stats = [
      { label: "New", value: counts.new.toLocaleString("en-IN"), tone: "blue", delta: "Waiting for a reply" },
      { label: "Contacted", value: counts.contacted.toLocaleString("en-IN"), tone: "lavender" },
      { label: "Demo scheduled", value: counts.scheduled.toLocaleString("en-IN"), tone: "peach" },
      { label: "Closed", value: counts.closed.toLocaleString("en-IN"), tone: "sage", delta: `${counts.spam.toLocaleString("en-IN")} marked spam` },
    ];
    body = (
      <Suspense fallback={<PageSkeletonTable />}>
        <LeadsView items={page.items} total={page.total} now={new Date().toISOString()} />
      </Suspense>
    );
  }
  return (
    <AdminModulePage moduleKey="leads" stats={stats}>
      {body}
    </AdminModulePage>
  );
}
