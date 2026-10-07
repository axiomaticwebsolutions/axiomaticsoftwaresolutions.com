/**
 * GET /api/admin/overview?range=7d|30d|90d|12m -> OverviewData (lib/admin/overview/model.ts): KPIs with the previous
 * period, the revenue chart, orders by payment status, webhook results, product performance, license health, support
 * workload and, for roles with `audit.view`, the latest audit rows (null otherwise). Any active staff member (the
 * Overview is open to every role). An unknown range falls back to 30 days. Ranges are IST (decisions.md Phase 6).
 */
import { adminRoute } from "@/lib/admin/http";
import { parseRange } from "@/lib/admin/overview/range";
import { getAdminOverview } from "@/lib/admin/overview/service";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute(null, async ({ req, can }) => {
  const range = parseRange(req.nextUrl.searchParams.get("range"));
  return json(await getAdminOverview(db, { range, now: new Date(), includeActivity: can("audit.view") }));
});
