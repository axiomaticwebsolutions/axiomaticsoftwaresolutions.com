/**
 * POST /api/admin/licenses/bulk { action: "extend" | "suspend", ids, days?, reason } (licenses.manage): the bulk bar's
 * "Extend 30 days" / "Suspend". -> { updated: string[], skipped: { id, reason }[] }; one audit row per license changed.
 */
import { bulkLicenseAction } from "@/lib/admin/licenses/actions";
import { bulkLicenseBody } from "@/lib/admin/licenses/schemas";
import { adminRoute } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute("licenses.manage", async ({ body, staff, actor }) => {
  const input = await body(bulkLicenseBody);
  const result = await bulkLicenseAction({ action: input.action, ids: input.ids, days: input.days }, { staff, actor, input });
  return json(result);
});
