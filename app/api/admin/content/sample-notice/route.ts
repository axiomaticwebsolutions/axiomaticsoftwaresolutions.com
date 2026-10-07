/**
 * GET   /api/admin/content/sample-notice  (content.manage) -> { notice: { enabled, text, updatedAt } }
 * PATCH /api/admin/content/sample-notice  (content.manage) { enabled?, text? } -> { notice, changed }; revalidates the storefront.
 */
import { noticePatchSchema } from "@/lib/admin/content/schemas";
import { getContentNotices, updateContentNotice } from "@/lib/admin/content/service";
import { adminRoute } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const GET = adminRoute("content.manage", async () => json({ notice: (await getContentNotices())["sample-notice"] }));

export const PATCH = adminRoute("content.manage", async ({ body, actor }) =>
  json(await updateContentNotice("sample-notice", await body(noticePatchSchema), { actor })),
);
