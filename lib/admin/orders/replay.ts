/**
 * Webhook replay (POST /api/admin/webhooks/:eventId/replay; payments.replay = Owner / Admin / Finance; decisions.md
 * Phase 3 "Phase 6" note): rebuilds the NormalizedEvent from the stored WebhookEvent.payload and runs it through
 * processPaymentEvent(provider, event, { replayedById }). The stored event row is the idempotency guard, so a replay
 * answers `duplicate_ignored` and changes nothing (it records a WebhookDelivery with replayedById). Audited
 * "Replayed webhook". Only signature-valid events are stored, so nothing unverified can be replayed.
 */
import "server-only";
import { z } from "zod";
import { audit, type AuditActor } from "@/lib/audit";
import { db as defaultDb } from "@/lib/db";
import { errors } from "@/lib/http";
import { PAYMENT_EVENT_TYPES, type NormalizedEvent } from "@/lib/payments/types";
import { processPaymentEvent } from "@/lib/payments/webhook";
import type { ReplayResponse } from "./model";

export const AMBIGUOUS_EVENT_MESSAGE = "Several providers sent an event with this id. Choose the provider.";
export const NOT_REPLAYABLE_MESSAGE = "This stored event can\u2019t be replayed.";

const storedEvent = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(PAYMENT_EVENT_TYPES),
  providerOrderId: z.string().min(1).max(200),
  providerPaymentId: z.string().min(1).max(200).optional(),
  providerRefundId: z.string().min(1).max(200).optional(),
  amountPaise: z.number().int().nonnegative(),
  currency: z.string().min(1).max(10),
  method: z.string().max(40).optional(),
  failureReason: z.string().max(300).optional(),
  occurredAt: z.iso.datetime().optional(),
});

/** The NormalizedEvent a stored payload describes, or null when it is not a complete event. */
export function eventFromPayload(payload: unknown, eventId: string): NormalizedEvent | null {
  const parsed = storedEvent.safeParse(payload);
  if (!parsed.success || parsed.data.id !== eventId) return null;
  const { occurredAt, ...rest } = parsed.data;
  return { ...rest, ...(occurredAt ? { occurredAt: new Date(occurredAt) } : {}) };
}

export type ReplayInput = { eventId: string; provider?: string | null; staff: { id: string }; actor: AuditActor };

export async function replayWebhookEvent(input: ReplayInput): Promise<ReplayResponse & { orderId: string | null }> {
  const events = await defaultDb.webhookEvent.findMany({
    where: { id: input.eventId, ...(input.provider ? { provider: input.provider } : {}) },
    select: { provider: true, id: true, orderId: true, payload: true, type: true },
    take: 2,
  });
  if (events.length === 0) throw errors.notFound("Webhook event");
  if (events.length > 1) throw errors.conflict("ambiguous_event", AMBIGUOUS_EVENT_MESSAGE);
  const stored = events[0] as (typeof events)[number];
  const event = eventFromPayload(stored.payload, stored.id);
  if (!event) throw errors.conflict("not_replayable", NOT_REPLAYABLE_MESSAGE);

  const { result } = await processPaymentEvent(stored.provider, event, { replayedById: input.staff.id });
  await audit(defaultDb, input.actor, {
    action: "Replayed webhook",
    target: `${event.type} \u00B7 ${stored.id}`,
    targetType: "webhook",
    targetId: stored.id,
    detail:
      result === "duplicate_ignored"
        ? `Idempotency check: duplicate ignored${stored.orderId ? ` \u00B7 order ${stored.orderId}` : ""}`
        : `Result: ${result}${stored.orderId ? ` \u00B7 order ${stored.orderId}` : ""}`,
  });
  return { eventId: stored.id, provider: stored.provider, result, orderId: stored.orderId };
}
