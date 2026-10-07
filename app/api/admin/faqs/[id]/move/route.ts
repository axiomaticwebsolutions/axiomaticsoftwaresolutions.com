/** POST /api/admin/faqs/:id/move (content.manage) { direction: "up" | "down" } -> { faq, changed }; audited "Reordered FAQ". */
import { faqMoveSchema } from "@/lib/admin/content/schemas";
import { moveFaq } from "@/lib/admin/content/service";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("content.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "FAQ");
  return json(await moveFaq(id, await body(faqMoveSchema), { actor }));
});
