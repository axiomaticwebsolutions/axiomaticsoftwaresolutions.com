/**
 * POST /api/admin/webhooks/:eventId/replay { provider? } (payments.replay: Owner, Admin, Finance): re-runs the stored,
 * signature-valid event through the idempotent payment handler (lib/admin/orders/replay.ts). The stored event is the
 * idempotency guard, so the result is `duplicate_ignored` and nothing is re-issued. Audited "Replayed webhook".
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { replayWebhookEvent } from "@/lib/admin/orders/replay";
import { replayBodySchema } from "@/lib/admin/orders/schemas";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("payments.replay", async ({ req, params, staff, actor, body }) => {
  const eventId = idParam(params, "id", "Webhook event");
  const input = req.headers.get("content-type") ? await body(replayBodySchema) : {};
  const { eventId: id, provider, result } = await replayWebhookEvent({ eventId, provider: input.provider, staff, actor });
  return json({ eventId: id, provider, result });
});
