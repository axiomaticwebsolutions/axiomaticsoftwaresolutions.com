/**
 * POST /api/admin/products/:id/hide (products.manage) { reason } -> { product }. Destructive rule products.hide:
 * reason required (422 reason_required), one audit row in the same transaction.
 */
import { setProductStatus } from "@/lib/admin/catalog/products";
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("products.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Product");
  const input = await body(destructiveBodySchema);
  return json({ product: await setProductStatus(id, "hide", { staff, actor, input }) });
});
