/**
 * GET /api/admin/products?q=&filter[category]=&filter[status]=published|hidden|draft&sort=name|latest|price|rank&page=&pageSize=
 *   (any staff) -> { items: AdminProductRow[], total, page, pageSize }
 * POST /api/admin/products (products.manage) { id, code, name, shortName, tagline, summary, categoryId, platforms, icon,
 *   tone?, rank?, demoEnabled? } -> 201 { product } (a DRAFT; audited "Created product")
 */
import { productListQuery } from "@/lib/admin/catalog/api";
import { createProduct, listProducts } from "@/lib/admin/catalog/products";
import { productCreateSchema } from "@/lib/admin/catalog/schemas";
import { adminRoute } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = adminRoute(null, async ({ req }) => json(await listProducts(productListQuery(req))));

export const POST = adminRoute("products.manage", async ({ body, actor }) => {
  const input = await body(productCreateSchema);
  return json({ product: await createProduct(input, { actor }) }, { status: 201 });
});
