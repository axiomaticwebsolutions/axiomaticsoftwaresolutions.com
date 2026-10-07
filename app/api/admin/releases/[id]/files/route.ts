/**
 * POST /api/admin/releases/:id/files (releases.manage) { platform, fileName, sizeBytes } -> 201 InstallerUploadTicket
 *   { upload: { url, method: "PUT", headers, expiresAt }, uploadToken }. The browser PUTs the file to `upload.url` with
 *   exactly `upload.headers`, then confirms with POST .../files/confirm. Drafts only (409 not_draft).
 */
import { createInstallerUpload } from "@/lib/admin/catalog/releases";
import { installerUploadSchema } from "@/lib/admin/catalog/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("releases.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Release");
  const input = await body(installerUploadSchema);
  return json(await createInstallerUpload(id, input, { actor, staffId: staff.id }), { status: 201 });
});
