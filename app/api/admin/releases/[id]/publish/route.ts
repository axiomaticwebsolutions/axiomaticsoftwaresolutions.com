/**
 * POST /api/admin/releases/:id/publish (releases.manage) -> { release }. DRAFT with at least one installer only
 * (409 not_draft / no_installers). Audited "Published release"; after the response, accounts entitled to the release
 * get the in-app notification and the "release_available" email (stable channel only).
 */
import { runAfterResponse } from "@/lib/admin/catalog/after";
import { notifyReleaseAvailable } from "@/lib/admin/catalog/release-notify";
import { publishRelease } from "@/lib/admin/catalog/releases";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("releases.manage", async ({ params, actor }) => {
  const id = idParam(params, "id", "Release");
  const release = await publishRelease(id, { actor });
  await runAfterResponse("release_notify_failed", () => notifyReleaseAvailable(id));
  return json({ release });
});
