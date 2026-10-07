/**
 * POST /api/admin/releases/:id/withdraw (releases.manage) { reason } -> { release }. PUBLISHED only (409 not_published);
 * reason required (422 reason_required); customers can no longer download it. Audited "Withdrew release".
 */
import { withdrawRelease } from "@/lib/admin/catalog/releases";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const withdrawSchema = z.strictObject({ reason: z.string().max(2000).nullish() });

export const POST = adminRoute<{ id: string }>("releases.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "Release");
  const { reason } = await body(withdrawSchema);
  return json({ release: await withdrawRelease(id, reason, { actor }) });
});
