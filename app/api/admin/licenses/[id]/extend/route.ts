/** POST /api/admin/licenses/:id/extend { days?, reason } (licenses.manage; days 1-365, default 30) -> { id, status, days, expiresAt, updatesUntil }. */
import { extendLicense } from "@/lib/admin/licenses/actions";
import { EXTEND_DEFAULT_DAYS } from "@/lib/admin/licenses/model";
import { extendLicenseBody } from "@/lib/admin/licenses/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("licenses.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "License");
  const input = await body(extendLicenseBody);
  return json(await extendLicense(id, input.days ?? EXTEND_DEFAULT_DAYS, { staff, actor, input }));
});
