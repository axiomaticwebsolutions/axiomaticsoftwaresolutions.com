/**
 * GET /api/admin/categories/:id (any staff) -> { category }
 * PATCH /api/admin/categories/:id (products.manage) { name?, blurb?, tone?, icon?, sortOrder? } -> { category, changed }
 * DELETE /api/admin/categories/:id (products.manage) { reason } -> { deleted: true }; 409 category_in_use while it has
 *   products; 422 reason_required (DESTRUCTIVE_ACTIONS "categories.delete", one audit row)
 */
import { deleteCategory, getCategory, updateCategory } from "@/lib/admin/catalog/products";
import { categoryUpdateSchema } from "@/lib/admin/catalog/schemas";
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { errors, json } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = adminRoute<Params>(null, async ({ params }) => {
  const category = await getCategory(idParam(params, "id", "Category"));
  if (!category) throw errors.notFound("Category");
  return json({ category });
});

export const PATCH = adminRoute<Params>("products.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "Category");
  const patch = await body(categoryUpdateSchema);
  return json(await updateCategory(id, patch, { actor }));
});

export const DELETE = adminRoute<Params>("products.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Category");
  await deleteCategory(id, { staff, actor, input: await body(destructiveBodySchema) });
  return json({ deleted: true });
});
