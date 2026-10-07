/** GET /api/admin/audit/:id -> { event: AuditRow } (404 "Audit event not found."). audit.view; read-only. */
import { adminRoute, idParam } from "@/lib/admin/http";
import { getAuditEvent } from "@/lib/admin/audit/service";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute<{ id: string }>("audit.view", async ({ params }) => {
  return json({ event: await getAuditEvent(db, idParam(params, "id", "Audit event")) });
});
