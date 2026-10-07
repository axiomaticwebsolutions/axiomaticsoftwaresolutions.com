import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AuditView } from "@/components/admin/audit/audit-view";
import { AdminModulePage } from "@/components/admin/module-page";
import { AUDIT_LIST_SPEC, type AuditRow } from "@/lib/admin/audit/model";
import { drawerIdParam, toUrlSearchParams, type PageSearchParams } from "@/lib/admin/audit/params";
import { auditFacets, getAuditEvent, listAudit, recentAuditActions } from "@/lib/admin/audit/service";
import { parseListQuery } from "@/lib/admin/list-query";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";

export const metadata = adminPageMetadata("audit");

/** Rendered (and its data loaded) only for roles that can open the module (AdminModulePage gate: audit.view). */
async function AuditSection({ params }: { params: PageSearchParams }) {
  const now = new Date();
  const actions = await recentAuditActions(db);
  const [page, facets] = await Promise.all([
    listAudit(db, parseListQuery(toUrlSearchParams(params), AUDIT_LIST_SPEC), { actions }),
    auditFacets(db, actions),
  ]);
  const id = drawerIdParam(params);
  let selected: AuditRow | null = null;
  if (id && !page.items.some((row) => row.id === id)) {
    selected = await getAuditEvent(db, id).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    });
  }
  return <AuditView data={page} facets={facets} selected={selected} now={now.toISOString()} />;
}

/**
 * /admin/audit (Admin Console.dc.html #audit; decisions.md Phase 6): Owner and Administrator. Append-only list with
 * filters, search, a read-only event drawer (?id=) and CSV (the export is audited).
 */
export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const params = await searchParams;
  return (
    <AdminModulePage moduleKey="audit">
      <AuditSection params={params} />
    </AdminModulePage>
  );
}
