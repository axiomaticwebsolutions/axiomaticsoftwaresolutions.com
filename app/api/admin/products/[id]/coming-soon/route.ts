/**
 * POST /api/admin/products/:id/coming-soon (products.manage) { reason } -> { product }. Destructive rule
 * products.coming_soon: reason required (422 reason_required), one audit row in the same transaction.
 * From DRAFT or HIDDEN only (409 already_coming_soon / published); 409 not_ready (with blockers) while the storefront
 * copy (name, tagline, summary, category, icon, a feature) is incomplete or licenses exist. Plans and releases are not
 * needed: the product is listed with a waitlist form and never sold (decisions.md 2026-10-09).
 */
import { setProductStatus } from "@/lib/admin/catalog/products";
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("products.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Product");
  const input = await body(destructiveBodySchema);
  return json({ product: await setProductStatus(id, "coming_soon", { staff, actor, input }) });
});
