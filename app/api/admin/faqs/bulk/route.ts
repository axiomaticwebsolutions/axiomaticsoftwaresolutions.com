/** POST /api/admin/faqs/bulk (content.manage) { ids: string[] (1-100), published } -> { updated } (prototype bulk "Unpublish"). */
import { faqBulkSchema } from "@/lib/admin/content/schemas";
import { bulkSetFaqsPublished } from "@/lib/admin/content/service";
import { adminRoute } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute("content.manage", async ({ body, actor }) => json(await bulkSetFaqsPublished(await body(faqBulkSchema), { actor })));
