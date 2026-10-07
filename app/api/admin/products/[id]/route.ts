/**
 * GET /api/admin/products/:id (any staff) -> { product: AdminProductDetail }
 * PATCH /api/admin/products/:id (products.manage) { name?, shortName?, tagline?, summary?, categoryId?, platforms?, icon?,
 *   tone?, rank?, demoEnabled?, content?, relatedIds?, code? } -> { product, changed } (audited "Updated product listing";
 *   code is 409 code_locked once licenses exist)
 */
import { getProductDetail, updateProduct } from "@/lib/admin/catalog/products";
import { productUpdateSchema } from "@/lib/admin/catalog/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { errors, json } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = adminRoute<Params>(null, async ({ params }) => {
  const product = await getProductDetail(idParam(params, "id", "Product"));
  if (!product) throw errors.notFound("Product");
  return json({ product });
});

export const PATCH = adminRoute<Params>("products.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "Product");
  const patch = await body(productUpdateSchema);
  return json(await updateProduct(id, patch, { actor }));
});
