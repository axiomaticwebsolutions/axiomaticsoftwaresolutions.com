/**
 * POST /api/admin/products/:id/publish (products.manage) { reason } -> { product }. Destructive rule products.publish:
 * reason required (422 reason_required), one audit row in the same transaction.
 * 409 not_ready (with blockers) while content, a plan on sale or a published release is missing.
 */
import { setProductStatus } from "@/lib/admin/catalog/products";
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("products.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Product");
  const input = await body(destructiveBodySchema);
  return json({ product: await setProductStatus(id, "publish", { staff, actor, input }) });
});
