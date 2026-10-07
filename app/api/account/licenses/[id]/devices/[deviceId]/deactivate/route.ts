/**
 * POST /api/account/licenses/:id/devices/:deviceId/deactivate (no body, or {}) ->
 * 200 { status: "deactivated", device, devicesUsed, deviceLimit, selfServiceResetsLeft, selfServiceResetsPerYear }.
 * Team permission `devices.manage` (Owner, Technical), CSRF + same origin, verified email. At most the yearly
 * self-service limit (Settings, default 3) per license per IST calendar year: 429 `reset_limit` with the portal copy and
 * Retry-After until 1 January (IST). 409 `already_deactivated` / `license_not_usable`; 404 for a license outside the
 * account or a device of another license. 60 device actions / 10 min per user.
 */
import { parseEmptyBody } from "@/lib/auth/flows/route-helpers";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, route } from "@/lib/http";
import { requireLicenseMember, selfServiceLimit } from "@/lib/licensing/account";
import { selfServiceDeactivate } from "@/lib/licensing/devices";
import { isLicenseIdShape, isRecordIdShape } from "@/lib/validation/license-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; deviceId: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "devices.manage", mutation: true });
  await parseEmptyBody(req);
  const { id, deviceId } = await ctx.params;
  if (!isLicenseIdShape(id)) throw errors.notFound("License");
  if (!isRecordIdShape(deviceId)) throw errors.notFound("Device");
  enforce(await hit(db, RATE_LIMITS.accountDevices(member.user.id)));
  const result = await selfServiceDeactivate(
    {
      accountId: member.account.id,
      role: member.membership.role,
      licenseId: id,
      deviceId,
      user: { id: member.user.id, name: member.user.name },
      limitPerYear: await selfServiceLimit(db),
    },
    db,
  );
  return json({ status: "deactivated", ...result });
});
