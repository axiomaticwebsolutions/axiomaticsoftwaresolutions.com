/**
 * GET /api/admin/releases?q=&filter[product]=&filter[status]=latest|published|draft|withdrawn&sort=-date|release
 *   &page=&pageSize= (any staff) -> { items: AdminReleaseRow[], total, page, pageSize } (newest first, drafts on top)
 * POST /api/admin/releases (releases.manage) { productId, version, channel?, notes? } -> 201 { release } (a DRAFT)
 */
import { releaseListQuery } from "@/lib/admin/catalog/api";
import { createRelease, listReleases } from "@/lib/admin/catalog/releases";
import { releaseCreateSchema } from "@/lib/admin/catalog/schemas";
import { adminRoute } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = adminRoute(null, async ({ req }) => json(await listReleases(releaseListQuery(req))));

export const POST = adminRoute("releases.manage", async ({ body, actor }) => {
  const input = await body(releaseCreateSchema);
  return json({ release: await createRelease(input, { actor }) }, { status: 201 });
});
