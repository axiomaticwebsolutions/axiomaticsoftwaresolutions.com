/**
 * GET /api/account/licenses/:id -> 200 { license, devices, history, renewalOptions, locations }.
 * One license of the active business account (any team role): masked key, terms, derived status, self-service
 * deactivations left, devices (active first), history from LicenseEvent (newest first) and renewal options.
 * 404 for unknown ids and for licenses of other accounts. 401 / 403 as the list. no-store.
 */
import { db } from "@/lib/db";
import { errors, json, route } from "@/lib/http";
import { getAccountLicenseDetail, requireLicenseMember } from "@/lib/licensing/account";
import { isLicenseIdShape } from "@/lib/validation/license-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "licenses.view" });
  const { id } = await ctx.params;
  if (!isLicenseIdShape(id)) throw errors.notFound("License");
  const detail = await getAccountLicenseDetail(db, { accountId: member.account.id, role: member.membership.role }, id, new Date());
  return json(detail);
});
