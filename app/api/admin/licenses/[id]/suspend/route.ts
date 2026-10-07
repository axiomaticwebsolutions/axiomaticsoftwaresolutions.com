/** POST /api/admin/licenses/:id/suspend { reason } (licenses.manage) -> { id, status }. 409 license_revoked / already_suspended. */
import { suspendLicense } from "@/lib/admin/licenses/actions";
import { licenseActionBody } from "@/lib/admin/licenses/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("licenses.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "License");
  const input = await body(licenseActionBody);
  return json(await suspendLicense(id, { staff, actor, input }));
});
