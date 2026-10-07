/**
 * POST /api/admin/plans/bulk-archive (pricing.manage) { ids: string[] (1-100), reason } -> { archived, skipped }.
 * Rule plans.archive (reason required); one "Archived plan" audit row per plan archived, all in one transaction.
 */
import { bulkArchivePlans } from "@/lib/admin/catalog/plans";
import { MAX_BULK_PLANS, SLUG_RE } from "@/lib/admin/catalog/schemas";
import { destructiveFields } from "@/lib/admin/destructive";
import { adminRoute } from "@/lib/admin/http";
import { json } from "@/lib/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bulkArchiveSchema = z.strictObject({
  ...destructiveFields,
  ids: z
    .array(z.string().trim().max(60).regex(SLUG_RE, "Unknown plan."))
    .min(1, "Select at least one plan.")
    .max(MAX_BULK_PLANS, `Archive up to ${MAX_BULK_PLANS} plans at a time.`),
});

export const POST = adminRoute("pricing.manage", async ({ body, staff, actor }) => {
  const { ids, ...input } = await body(bulkArchiveSchema);
  return json(await bulkArchivePlans(ids, { staff, actor, input }));
});
