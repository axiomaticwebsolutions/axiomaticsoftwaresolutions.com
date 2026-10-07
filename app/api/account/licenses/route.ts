/**
 * GET /api/account/licenses?status=&product=&q=&sort= -> 200 { licenses, total, truncated, products }.
 * Every license of the active business account (any team role), keys masked. status: all | active | expiring |
 * expired | trial | suspended | revoked (derived); product: product id | all; q: license id, product name or key
 * last 4; sort: product | status | expiry | devices | updates, "-" prefix for descending (default expiry ascending).
 * 401 signed out, 403 no_account / email_unverified, 422 validation_failed for bad parameters. no-store.
 */
import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { listAccountLicenses, requireLicenseMember } from "@/lib/licensing/account";
import { parseLicenseListQuery } from "@/lib/validation/license-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "licenses.view" });
  const query = parseLicenseListQuery(req.nextUrl.searchParams);
  const list = await listAccountLicenses(db, { accountId: ctx.account.id, role: ctx.membership.role }, query, new Date());
  return json(list);
});
