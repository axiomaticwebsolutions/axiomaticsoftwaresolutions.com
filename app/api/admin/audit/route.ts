/**
 * GET /api/admin/audit?q=&filter[role]=system|owner|admin|support|finance&filter[actor]=<staff id>
 *   &filter[action]=<action slug, e.g. changed-staff-role>&filter[targetType]=order&filter[from]=YYYY-MM-DD
 *   &filter[to]=YYYY-MM-DD (IST days)&sort=-createdAt|createdAt|actor|-actor|action|-action&page=&pageSize=
 *   -> { items: AuditRow[], total, page, pageSize }.
 * audit.view (Owner, Administrator). The audit log is append-only: this area exports no PUT, PATCH or DELETE.
 */
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { AUDIT_LIST_SPEC } from "@/lib/admin/audit/model";
import { listAudit } from "@/lib/admin/audit/service";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("audit.view", async ({ req }) => {
  return json(await listAudit(db, parseListQuery(req, AUDIT_LIST_SPEC)));
});
