/**
 * PATCH /api/account/locations/:id { name } -> 200 { location }: renames a location.
 * DELETE /api/account/locations/:id -> 200 { deleted: true, id, devicesMoved }: deletes it and moves its devices to
 * "Unassigned". Both: team permission `devices.manage` (Owner, Technical contact), CSRF + same origin, verified email;
 * 404 for locations of other accounts and unknown ids; 422 fieldErrors.name for a duplicate name. 60 location
 * changes / 10 min per user.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { deleteLocation, LOCATION_NOT_FOUND, renameLocation } from "@/lib/portal/locations";
import { isRecordIdShape } from "@/lib/validation/license-actions";
import { locationBodySchema, PORTAL_BODY_MAX_BYTES } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "devices.manage", mutation: true });
  const { name } = await parseJsonBody(req, locationBodySchema, { maxBytes: PORTAL_BODY_MAX_BYTES });
  const { id } = await ctx.params;
  if (!isRecordIdShape(id)) throw errors.notFound(LOCATION_NOT_FOUND);
  enforce(await hit(db, RATE_LIMITS.accountLocations(member.user.id)));
  return json({ location: await renameLocation(member.account.id, id, name, db) });
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "devices.manage", mutation: true });
  const { id } = await ctx.params;
  if (!isRecordIdShape(id)) throw errors.notFound(LOCATION_NOT_FOUND);
  enforce(await hit(db, RATE_LIMITS.accountLocations(member.user.id)));
  const result = await deleteLocation(member.account.id, id, db);
  return json({ deleted: true, ...result });
});
