/**
 * GET /api/admin/releases/:id (any staff) -> { release: AdminReleaseDetail }
 * PATCH /api/admin/releases/:id (releases.manage) { version?, channel?, notes? } -> { release, changed }
 *   (drafts: everything, the version only while no installer is uploaded; published: notes only)
 * DELETE /api/admin/releases/:id (releases.manage) { reason } -> { deleted: true } (drafts only; their installers are
 *   removed); 422 reason_required (DESTRUCTIVE_ACTIONS "releases.delete", one audit row)
 */
import { deleteDraftRelease, getReleaseDetail, updateRelease } from "@/lib/admin/catalog/releases";
import { releaseUpdateSchema } from "@/lib/admin/catalog/schemas";
import { destructiveBodySchema } from "@/lib/admin/destructive";
import { adminRoute, idParam } from "@/lib/admin/http";
import { errors, json } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = adminRoute<Params>(null, async ({ params }) => {
  const release = await getReleaseDetail(idParam(params, "id", "Release"));
  if (!release) throw errors.notFound("Release");
  return json({ release });
});

export const PATCH = adminRoute<Params>("releases.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "Release");
  const patch = await body(releaseUpdateSchema);
  return json(await updateRelease(id, patch, { actor }));
});

export const DELETE = adminRoute<Params>("releases.manage", async ({ params, body, staff, actor }) => {
  const id = idParam(params, "id", "Release");
  await deleteDraftRelease(id, { staff, actor, input: await body(destructiveBodySchema) });
  return json({ deleted: true });
});
