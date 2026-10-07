/**
 * GET   /api/admin/leads/:id (leads.view) -> { lead, history }
 * PATCH /api/admin/leads/:id (leads.view) { status?, note? } -> { lead, history, changed }
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { leadUpdateSchema } from "@/lib/admin/leads/schemas";
import { getLeadDetail, updateLead } from "@/lib/admin/leads/service";
import { json } from "@/lib/http";

type Params = { id: string };

export const GET = adminRoute<Params>("leads.view", async ({ params }) => json(await getLeadDetail(idParam(params, "id", "Request"))));

export const PATCH = adminRoute<Params>("leads.view", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "Request");
  return json(await updateLead(id, await body(leadUpdateSchema), { actor }));
});
