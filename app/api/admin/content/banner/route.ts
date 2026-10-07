/**
 * GET   /api/admin/content/banner  (content.manage) -> { notice: { enabled, text, updatedAt } }
 * PATCH /api/admin/content/banner  (content.manage) { enabled?, text? } -> { notice, changed }; revalidates the storefront.
 */
import { noticePatchSchema } from "@/lib/admin/content/schemas";
import { getContentNotices, updateContentNotice } from "@/lib/admin/content/service";
import { adminRoute } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const GET = adminRoute("content.manage", async () => json({ notice: (await getContentNotices())["banner"] }));

export const PATCH = adminRoute("content.manage", async ({ body, actor }) =>
  json(await updateContentNotice("banner", await body(noticePatchSchema), { actor })),
);
