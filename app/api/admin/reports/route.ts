/**
 * GET /api/admin/reports?range=7d|30d|90d|12m -> ReportsData (lib/admin/reports/model.ts): sales by month and by
 * product, the GST summary by month with credit notes apart, license health per product and the support workload.
 * `reports.view` (Owner, Administrator, Finance). An unknown range falls back to 30 days.
 */
import { adminRoute } from "@/lib/admin/http";
import { parseRange } from "@/lib/admin/overview/range";
import { getAdminReports } from "@/lib/admin/reports/service";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("reports.view", async ({ req }) => {
  const range = parseRange(req.nextUrl.searchParams.get("range"));
  return json(await getAdminReports(db, { range, now: new Date() }));
});
