/**
 * GET /api/account/activity/export.csv?kind=&q= -> 200 text/csv "activity-log.csv": When (ISO), Who, Action, Item,
 * Type for every entry matching the filters (newest first, at most 20,000 rows), UTF-8 with BOM, every cell quoted,
 * formula-like cells prefixed with an apostrophe. `X-Row-Count` carries the number of rows (for the
 * "Exported {n} rows to activity-log.csv" toast). Team permission `activity.view` (Owner only), verified email;
 * 403 for cross-site requests (`Sec-Fetch-Site: cross-site`, like the other server exports), checked before the
 * rate limit so another site cannot use up the Owner's exports; 429 after 10 exports in 10 minutes per user.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { csvHeaders } from "@/lib/csv";
import { db } from "@/lib/db";
import { errors, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { ACTIVITY_CSV_FILE_NAME, exportAccountActivityCsv } from "@/lib/portal/activity";
import { isCrossSiteRequest } from "@/lib/portal/export";
import { parseActivityQuery } from "@/lib/validation/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const member = await requireLicenseMember(req, { perm: "activity.view" });
  if (isCrossSiteRequest(req.headers)) throw errors.forbidden();
  const { kind, q } = parseActivityQuery(req.nextUrl.searchParams);
  enforce(await hit(db, RATE_LIMITS.activityExport(member.user.id)));
  const { csv, rows, truncated } = await exportAccountActivityCsv(db, member.account.id, { kind, q });
  return new Response(csv, {
    status: 200,
    headers: {
      ...csvHeaders(ACTIVITY_CSV_FILE_NAME),
      "x-row-count": String(rows),
      ...(truncated ? { "x-truncated": "1" } : {}),
    },
  });
});
