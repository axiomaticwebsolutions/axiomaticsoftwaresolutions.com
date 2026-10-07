/**
 * GET    /api/admin/faqs/:id  (content.manage)  -> { faq }
 * PATCH  /api/admin/faqs/:id  (content.manage)  { page?, question?, answer?, href?, published? } -> { faq, changed }
 * DELETE /api/admin/faqs/:id  (content.manage)  { reason } -> { id }  (DESTRUCTIVE_ACTIONS faqs.delete)
 */
import { faqUpdateSchema } from "@/lib/admin/content/schemas";
import { deleteFaq, loadFaqs, updateFaq } from "@/lib/admin/content/service";
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { errors, json } from "@/lib/http";

type Params = { id: string };

export const GET = adminRoute<Params>("content.manage", async ({ params }) => {
  const id = idParam(params, "id", "FAQ");
  const faq = (await loadFaqs()).faqs.find((f) => f.id === id);
  if (!faq) throw errors.notFound("FAQ");
  return json({ faq });
});

export const PATCH = adminRoute<Params>("content.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "FAQ");
  return json(await updateFaq(id, await body(faqUpdateSchema), { actor }));
});

export const DELETE = adminRoute<Params>("content.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "FAQ");
  return json(await deleteFaq(id, await body(destructiveBodySchema), { staff, actor }));
});
