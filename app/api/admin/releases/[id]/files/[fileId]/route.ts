/**
 * DELETE /api/admin/releases/:id/files/:fileId (releases.manage) { reason } -> { release }. Drafts only (409 not_draft);
 * 422 reason_required (DESTRUCTIVE_ACTIONS "releases.remove_installer", one audit row).
 */
import { removeInstaller } from "@/lib/admin/catalog/releases";
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const DELETE = adminRoute<{ id: string; fileId: string }>("releases.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Release");
  const fileId = idParam(params, "fileId", "Installer");
  return json({ release: await removeInstaller(id, fileId, { staff, actor, input: await body(destructiveBodySchema) }) });
});
