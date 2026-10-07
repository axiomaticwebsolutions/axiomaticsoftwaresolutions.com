/**
 * PATCH /api/account/devices/:id { name?, locationId? } -> 200 { device }.
 * Team permission `devices.manage` (Owner, Technical), CSRF + same origin, verified email. name: 1-80 characters;
 * locationId: a location of the same account, or null to unassign (422 fieldErrors.locationId otherwise). 409
 * `device_inactive` for a deactivated device; 404 for devices outside the account. 60 device actions / 10 min per user.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { renameOrMoveDevice } from "@/lib/licensing/devices";
import { isRecordIdShape, LICENSE_ACTION_BODY_MAX_BYTES, updateDeviceSchema } from "@/lib/validation/license-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "devices.manage", mutation: true });
  const changes = await parseJsonBody(req, updateDeviceSchema, { maxBytes: LICENSE_ACTION_BODY_MAX_BYTES });
  const { id } = await ctx.params;
  if (!isRecordIdShape(id)) throw errors.notFound("Device");
  enforce(await hit(db, RATE_LIMITS.accountDevices(member.user.id)));
  const device = await renameOrMoveDevice(
    {
      accountId: member.account.id,
      role: member.membership.role,
      deviceId: id,
      changes,
      user: { id: member.user.id, name: member.user.name },
    },
    db,
  );
  return json({ device });
});
