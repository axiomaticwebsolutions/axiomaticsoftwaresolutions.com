/**
 * GET /api/account/export -> 200 application/json attachment "account-export-YYYY-MM-DD.json": the active business
 * account's details, team, locations, licenses (masked keys), devices, orders, invoices, payments, tickets (no staff
 * notes) and activity (lib/portal/export.ts lists what is never included). Owner only (`team.manage`), verified
 * email; 403 for cross-site requests; 5 exports / hour per user (429). no-store.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { log } from "@/lib/log";
import { buildAccountExport, exportFileName, isCrossSiteRequest } from "@/lib/portal/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "team.manage" });
  if (isCrossSiteRequest(req.headers)) throw errors.forbidden();
  enforce(await hit(db, RATE_LIMITS.accountExport(ctx.user.id)));
  const now = new Date();
  const data = await buildAccountExport(db, {
    accountId: ctx.account.id,
    exportedBy: { name: ctx.user.name, email: ctx.user.email },
    now,
  });
  log.info("account_exported", { accountId: ctx.account.id, userId: ctx.user.id, truncated: data.truncated });
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(now)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
