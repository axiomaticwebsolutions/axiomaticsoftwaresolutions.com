/**
 * POST /api/admin/licenses/:id/devices/:deviceId/deactivate { reason } (licenses.manage) -> { id, deviceId, name }.
 * Frees one slot; never counts toward the customer’s self-service limit. 409 already_deactivated / license_revoked.
 */
import { deactivateLicenseDevice } from "@/lib/admin/licenses/actions";
import { licenseActionBody } from "@/lib/admin/licenses/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string; deviceId: string }>("licenses.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "License");
  const deviceId = idParam(params, "deviceId", "Device");
  const input = await body(licenseActionBody);
  return json(await deactivateLicenseDevice(id, deviceId, { staff, actor, input }));
});
