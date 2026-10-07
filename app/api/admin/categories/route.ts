/**
 * GET /api/admin/categories?q=&page=&pageSize= (any staff) -> { items: AdminCategoryRow[], total, page, pageSize }
 *   (storefront order: sort order, then name)
 * POST /api/admin/categories (products.manage) { id, name, blurb?, tone, icon, sortOrder? } -> 201 { category }
 */
import { createCategory, listCategories } from "@/lib/admin/catalog/products";
import { categoryCreateSchema } from "@/lib/admin/catalog/schemas";
import { adminRoute } from "@/lib/admin/http";
import { pageResult, parseListQuery } from "@/lib/admin/list-query";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = adminRoute(null, async ({ req }) => {
  const query = parseListQuery(req, { sortable: ["sortOrder"], defaultSort: "sortOrder", defaultPageSize: 100 });
  const rows = await listCategories(undefined, query.q);
  return json(pageResult(rows.slice(query.skip, query.skip + query.take), rows.length, query));
});

export const POST = adminRoute("products.manage", async ({ body, actor }) => {
  const input = await body(categoryCreateSchema);
  return json({ category: await createCategory(input, { actor }) }, { status: 201 });
});
