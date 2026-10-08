/**
 * Request bodies of the admin order routes (strict Zod objects: unknown keys are 422). Server only (destructiveFields).
 * Admin records (docs/admin-records-design.md B1-B7): the item, coupon and billing schemas are checkout's
 * (lib/validation/checkout.ts, lib/validation/billing.ts), so an order staff create is validated exactly like one placed
 * at checkout. Reasons are checked by requireReason() (422 reason_required, before any lookup or write), not here.
 */
import { z } from "zod";
import { destructiveFields } from "@/lib/admin/destructive";
import { ADMIN_ID_RE } from "@/lib/admin/licenses/schemas";
import { PAYMENT_PROVIDER_KEYS } from "@/lib/payments/types";
import { billingSchema } from "@/lib/validation/billing";
import {
  billingStateSchema,
  CHECKOUT_ERRORS,
  CHECKOUT_MAX_LINES,
  checkoutItemSchema,
  couponCodeSchema,
  isOrderIdShape,
} from "@/lib/validation/checkout";
import { ADMIN_ORDERS_BULK_MAX, OFFLINE_METHODS } from "./model";
import { ORDER_RECORD_MESSAGES, referenceRequiredMessage } from "./records-model";

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

// ---------- Admin records (orders) ----------

const reasonField = z.string().max(2000).nullish();
const accountIdField = z.string({ error: "Choose a customer." }).regex(ADMIN_ID_RE, "Choose a customer.");
const itemsSchema = z
  .array(checkoutItemSchema, { error: CHECKOUT_ERRORS.emptyCart })
  .max(CHECKOUT_MAX_LINES, { message: CHECKOUT_ERRORS.tooManyLines });
const requiredItems = itemsSchema.min(1, { message: CHECKOUT_ERRORS.emptyCart });

/** POST /api/admin/orders/quote: exactly one of `accountId` (a new order) and `orderId` (an order being edited). */
export const orderQuoteBody = z
  .strictObject({
    accountId: accountIdField.optional(),
    orderId: z.string().refine(isOrderIdShape, "Not an order id.").optional(),
    items: itemsSchema,
    couponCode: couponCodeSchema,
    billingState: billingStateSchema,
  })
  .superRefine((value, ctx) => {
    if ((value.accountId === undefined) === (value.orderId === undefined)) {
      ctx.addIssue({ code: "custom", path: [], message: ORDER_RECORD_MESSAGES.quoteTarget });
    }
  });
export type OrderQuoteInput = z.output<typeof orderQuoteBody>;

const orderCreateShape = {
  /** Client-generated when the form opens and kept across retries: a double submit returns the first order. */
  requestId: z.uuid({ error: "Reload the form and try again." }),
  accountId: accountIdField,
  items: requiredItems,
  couponCode: couponCodeSchema,
  billing: billingSchema,
  reason: reasonField,
};

/** POST /api/admin/orders: an unpaid order with a payment link (the customer pays online). */
export const orderCreateBody = z.strictObject(orderCreateShape);
export type OrderCreateInput = z.output<typeof orderCreateBody>;

/** POST /api/admin/orders/offline: the order and its payment, received in full outside the payment provider. */
export const offlineOrderBody = z
  .strictObject({
    ...orderCreateShape,
    method: z.enum(OFFLINE_METHODS, { error: "Choose how the money was paid." }),
    reference: z
      .string()
      .trim()
      .max(64, { message: "Use 64 characters or fewer." })
      .regex(/^[A-Za-z0-9 /._-]*$/, { message: ORDER_RECORD_MESSAGES.referenceInvalid })
      .nullish()
      .transform((value) => (value ? value : null)),
    receivedOn: z.iso.date({ error: ORDER_RECORD_MESSAGES.receivedOn }),
    amountPaise: z.int({ error: "Enter the amount received." }).positive({ message: "Enter the amount received." }).max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((value, ctx) => {
    const message = referenceRequiredMessage(value.method);
    if (message && !value.reference) ctx.addIssue({ code: "custom", path: ["reference"], message });
  });
export type OfflineOrderInput = z.output<typeof offlineOrderBody>;

/** PATCH /api/admin/orders/:id: an unpaid order's items, coupon (null removes it) or billing; at least one. */
export const orderPatchBody = z
  .strictObject({
    items: requiredItems.optional(),
    couponCode: couponCodeSchema.optional(),
    billing: billingSchema.optional(),
    reason: reasonField,
  })
  .superRefine((value, ctx) => {
    if (value.items === undefined && value.couponCode === undefined && value.billing === undefined) {
      ctx.addIssue({ code: "custom", path: [], message: ORDER_RECORD_MESSAGES.nothingToUpdate });
    }
  });
export type OrderPatchInput = z.output<typeof orderPatchBody>;

/** POST /api/admin/orders/:id/payment-link: `send: true` also emails it to the order email. */
export const paymentLinkBody = z.strictObject({ send: z.boolean().optional() });

/** POST /api/admin/orders/:id/cancel: `{ reason }` (DESTRUCTIVE_ACTIONS "orders.cancel"). */
export { destructiveBodySchema as orderCancelBody } from "@/lib/admin/destructive";

/**
 * POST /api/admin/orders/:id/correct-billing: the corrected billing details. Raw strings: the rules
 * (lib/admin/orders/correction-rules.ts) merge them with the stored snapshot and validate the result with checkout's
 * billingSchema, so `state` and `email` are accepted only to answer a clear refusal when they differ.
 */
const correctionText = z.string().max(400).nullish();
export const billingCorrectionBody = z.strictObject({
  billing: z.strictObject({
    name: correctionText,
    phone: correctionText,
    business: correctionText,
    address: correctionText,
    city: correctionText,
    pin: correctionText,
    gstin: correctionText,
    state: correctionText,
    email: correctionText,
  }),
  reason: reasonField,
});
export type BillingCorrectionInput = z.output<typeof billingCorrectionBody>;
