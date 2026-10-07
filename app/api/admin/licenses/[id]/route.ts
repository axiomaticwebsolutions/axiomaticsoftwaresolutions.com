/** GET /api/admin/licenses/:id (any staff): the drawer (masked key, terms, devices, history, orders). 404 when unknown. */
import { getAdminLicenseDetail } from "@/lib/admin/licenses/queries";
import { adminRoute, idParam } from "@/lib/admin/http";
import { db } from "@/lib/db";
import { errors, json } from "@/lib/http";

export const GET = adminRoute<{ id: string }>(null, async ({ params }) => {
  const license = await getAdminLicenseDetail(db, idParam(params, "id", "License"), new Date());
  if (!license) throw errors.notFound("License");
  return json({ license });
});
