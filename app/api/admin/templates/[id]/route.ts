/**
 * GET   /api/admin/templates/:id (templates.manage) -> { template }
 * PATCH /api/admin/templates/:id (templates.manage) { subject?, body?, active? } -> { template, changed }
 *       (422 for {{placeholders}} the template does not know)
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { templateUpdateSchema } from "@/lib/admin/templates/schemas";
import { getTemplate, updateTemplate } from "@/lib/admin/templates/service";
import { json } from "@/lib/http";

type Params = { id: string };

export const GET = adminRoute<Params>("templates.manage", async ({ params }) =>
  json({ template: await getTemplate(idParam(params, "id", "Template")) }),
);

export const PATCH = adminRoute<Params>("templates.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "Template");
  return json(await updateTemplate(id, await body(templateUpdateSchema), { actor }));
});
