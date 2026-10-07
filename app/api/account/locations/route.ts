/**
 * GET /api/account/locations -> 200 { locations: [{ id, name, activeDevices }], unassignedDevices, canManage }.
 * Every team role of the active business account, verified email.
 *
 * POST /api/account/locations { name } -> 201 { location }. Team permission `devices.manage` (Owner, Technical
 * contact), CSRF + same origin. Name 1-60 characters, unique per account (422 fieldErrors.name); at most 100
 * locations (409 location_limit). 60 location changes / 10 min per user.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { createLocation, listLocations } from "@/lib/portal/locations";
import { teamCan } from "@/lib/rbac";
import { locationBodySchema, PORTAL_BODY_MAX_BYTES } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "licenses.view" });
  const list = await listLocations(db, ctx.account.id);
  return json({ ...list, canManage: teamCan(ctx.membership.role, "devices.manage") });
});

export const POST = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "devices.manage", mutation: true });
  const { name } = await parseJsonBody(req, locationBodySchema, { maxBytes: PORTAL_BODY_MAX_BYTES });
  enforce(await hit(db, RATE_LIMITS.accountLocations(ctx.user.id)));
  const location = await createLocation(ctx.account.id, name, db);
  return json({ location }, { status: 201 });
});
