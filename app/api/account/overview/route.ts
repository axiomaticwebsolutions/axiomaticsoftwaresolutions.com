/**
 * GET /api/account/overview -> 200 AccountOverview (lib/portal/overview.ts): alerts, KPIs, device-slot utilisation,
 * the 12-month renewal timeline, spend by product and (Owner only, else null) the six latest activity entries.
 * Any team role of the active business account, verified email. 401 signed out, 403 no_account / email_unverified.
 * no-store.
 */
import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { getAccountOverview } from "@/lib/portal/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "licenses.view" });
  const overview = await getAccountOverview(
    db,
    { accountId: ctx.account.id, legalName: ctx.account.legalName, role: ctx.membership.role },
    new Date(),
  );
  return json(overview);
});
