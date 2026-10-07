/**
 * GET /api/account/devices?status=&location=&q= -> 200 { devices, truncated, stats, locations }.
 * Every device on the active business account's licenses (any team role). status: active (default) | stale (active,
 * not seen for 30 days) | inactive (deactivated) | all; location: location id | none | all; q: device name, OS or
 * license id. stats = active devices, free slots on usable licenses, stale devices, locations.
 * 401 signed out, 403 no_account / email_unverified, 422 validation_failed for bad parameters. no-store.
 */
import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { listAccountDevices, requireLicenseMember } from "@/lib/licensing/account";
import { parseDeviceListQuery } from "@/lib/validation/license-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "licenses.view" });
  const query = parseDeviceListQuery(req.nextUrl.searchParams);
  const fleet = await listAccountDevices(db, { accountId: ctx.account.id, role: ctx.membership.role }, query, new Date());
  return json(fleet);
});
