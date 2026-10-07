/** POST /api/admin/licenses/:id/reset-devices { reason } (licenses.manage) -> { id, deactivated }. Zeroes the self-service counter. */
import { resetLicenseDevices } from "@/lib/admin/licenses/actions";
import { licenseActionBody } from "@/lib/admin/licenses/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("licenses.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "License");
  const input = await body(licenseActionBody);
  return json(await resetLicenseDevices(id, { staff, actor, input }));
});
