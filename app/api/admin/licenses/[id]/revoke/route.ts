/** POST /api/admin/licenses/:id/revoke { reason, confirmId } (licenses.revoke; confirmId = the license id) -> { id, status }. */
import { revokeLicense } from "@/lib/admin/licenses/actions";
import { licenseActionBody } from "@/lib/admin/licenses/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("licenses.revoke", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "License");
  const input = await body(licenseActionBody);
  return json(await revokeLicense(id, { staff, actor, input }));
});
