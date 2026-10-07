/**
 * POST /api/admin/templates/:id/test (templates.manage) { subject?, body? } -> { sentTo }: the template with its sample
 * data, sent now to the signed-in staff member only (10 per hour; 429 too_many_attempts beyond).
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { templateTestSchema } from "@/lib/admin/templates/schemas";
import { sendTemplateTest } from "@/lib/admin/templates/service";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("templates.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Template");
  return json(await sendTemplateTest(id, await body(templateTestSchema), { staff, actor }));
});
