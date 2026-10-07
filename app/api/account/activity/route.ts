/**
 * GET /api/account/activity?kind=all|license|security|billing|team|ticket|download&q=&page= -> 200 { events: [{ id,
 * at, actorName, actorId, action, target, kind }], total, page, pageSize: 10, pageCount, retentionMonths: 24 }.
 * Newest first; `q` searches the person, action and item; entries older than 24 months are not listed.
 * Team permission `activity.view` (Owner only), verified email. 422 for an invalid query.
 */
import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { listAccountActivity } from "@/lib/portal/activity";
import { parseActivityQuery } from "@/lib/validation/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const member = await requireLicenseMember(req, { perm: "activity.view" });
  const query = parseActivityQuery(req.nextUrl.searchParams);
  return json(await listAccountActivity(db, member.account.id, query));
});
