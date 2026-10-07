/** POST /api/admin/licenses/:id/reinstate { reason } (licenses.manage) -> { id, status }. 409 not_suspended / license_revoked. */
import { reinstateLicense } from "@/lib/admin/licenses/actions";
import { licenseActionBody } from "@/lib/admin/licenses/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("licenses.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "License");
  const input = await body(licenseActionBody);
  return json(await reinstateLicense(id, { staff, actor, input }));
});
