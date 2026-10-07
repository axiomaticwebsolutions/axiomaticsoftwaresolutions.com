/**
 * POST /api/admin/renewals/remind { licenseIds } (renewals.remind): "Send reminder now" for 1-100 licenses ->
 * { queued: { id, templateId, recipients }[], skipped: { id, reason }[] }. One audit row per license queued.
 */
import { sendRenewalReminders } from "@/lib/admin/renewals/remind";
import { remindBody } from "@/lib/admin/renewals/schemas";
import { adminRoute } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute("renewals.remind", async ({ body, actor }) => {
  const input = await body(remindBody);
  return json(await sendRenewalReminders(input.licenseIds, { actor }));
});
