/**
 * POST /api/admin/releases/:id/files/confirm (releases.manage) { uploadToken } -> { file, release }. Checks the stored
 * object's size, computes its SHA-256 on the server and stores the installer (audited "Uploaded installer").
 */
import { confirmInstallerUpload } from "@/lib/admin/catalog/releases";
import { installerConfirmSchema } from "@/lib/admin/catalog/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
// Hashing a large installer reads the whole object.
export const maxDuration = 300;

export const POST = adminRoute<{ id: string }>("releases.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Release");
  const { uploadToken } = await body(installerConfirmSchema);
  return json(await confirmInstallerUpload(id, uploadToken, { actor, staffId: staff.id }));
});
