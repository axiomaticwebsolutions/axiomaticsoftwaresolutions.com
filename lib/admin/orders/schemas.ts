/**
 * Request bodies of the admin order routes (strict Zod objects: unknown keys are 422). Server only (destructiveFields).
 */
import { z } from "zod";
import { destructiveFields } from "@/lib/admin/destructive";
import { PAYMENT_PROVIDER_KEYS } from "@/lib/payments/types";
import { ADMIN_ORDERS_BULK_MAX } from "./model";

const ORDER_ID = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/, "Not an order id.");

/**
 * POST /api/admin/orders/:id/refund: reason + typed order id (DESTRUCTIVE_ACTIONS "orders.refund"). The console sends
 * no amount (a full refund); `amountPaise` is accepted for later partial refunds (decisions.md Phase 6). `paymentId`
 * (a Payment id from the drawer) refunds that captured payment alone when it did not pay the order (a duplicate).
 */
export const refundBodySchema = z.strictObject({
  ...destructiveFields,
  amountPaise: z.int().min(1).max(Number.MAX_SAFE_INTEGER).nullish(),
  paymentId: z.string().trim().min(1).max(64).nullish(),
});
export type RefundBody = z.output<typeof refundBodySchema>;

/** POST /api/admin/orders/:id/review: the reason is checked by requireReason (422 reason_required). */
export const reviewBodySchema = z.strictObject({ reason: z.string().max(2000).nullish() });

/** POST /api/admin/orders/resend-invoices */
export const resendBulkSchema = z.strictObject({
  ids: z.array(ORDER_ID).min(1, "Select at least one order.").max(ADMIN_ORDERS_BULK_MAX, `Select at most ${ADMIN_ORDERS_BULK_MAX} orders.`),
});

/** POST /api/admin/orders/:id/resend-invoice (no fields). */
export const emptyBodySchema = z.strictObject({});

/** POST /api/admin/webhooks/:eventId/replay: the provider only matters when two providers used the same event id. */
export const replayBodySchema = z.strictObject({ provider: z.enum(PAYMENT_PROVIDER_KEYS).nullish() });
