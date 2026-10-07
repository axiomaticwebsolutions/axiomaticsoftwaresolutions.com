/**
 * Request schemas for the checkout and order API (docs/api-contracts.md section 3, docs/decisions.md Phase 3).
 * Strict objects (unknown keys are rejected). Prices never come from the client: items carry plan ids, quantities,
 * kinds and target license ids only, and the server re-prices them with lib/pricing quote().
 */
import { z } from "zod";
import type { ItemKind } from "@/generated/prisma/enums";
import { BILLING_ERRORS, billingSchema } from "@/lib/validation/billing";
import { passwordSchema } from "@/lib/validation/password";
import { INDIAN_STATES } from "@/lib/validation/states";

/** Same ceilings as the client cart (lib/cart/store.ts); plans set lower limits through maxQty. */
export const CHECKOUT_MAX_LINES = 50;
export const CHECKOUT_MAX_QTY = 99;
export const COUPON_CODE_MAX = 40;
/** Order link tokens are about 80 characters; anything much longer is not ours. */
export const ORDER_TOKEN_MAX = 256;

export const CHECKOUT_ITEM_KINDS = ["NEW", "RENEWAL", "UPGRADE", "ADDON"] as const satisfies readonly ItemKind[];

/** Copy from Checkout.dc.html and the prototype's createOrder(). */
export const CHECKOUT_ERRORS = {
  emptyCart: "Your cart is empty.",
  acceptTerms: "Please accept the license agreement to continue.",
  item: "This cart item isn’t valid. Remove it and add it again.",
  tooManyLines: `Your cart can hold up to ${CHECKOUT_MAX_LINES} items.`,
  coupon: "Enter a valid coupon code.",
  billingState: BILLING_ERRORS.state,
} as const;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Plan, license and order ids: letters, digits, "_" and "-", at most 64 characters. */
export const idSchema = z.string({ error: CHECKOUT_ERRORS.item }).trim().regex(ID_RE, { message: CHECKOUT_ERRORS.item });

export const checkoutItemSchema = z.strictObject({
  planId: idSchema,
  qty: z
    .number({ error: CHECKOUT_ERRORS.item })
    .int({ message: CHECKOUT_ERRORS.item })
    .min(1, { message: CHECKOUT_ERRORS.item })
    .max(CHECKOUT_MAX_QTY, { message: CHECKOUT_ERRORS.item }),
  kind: z.enum(CHECKOUT_ITEM_KINDS, { error: CHECKOUT_ERRORS.item }).optional(),
  targetLicenseId: idSchema.nullish(),
});

export type CheckoutItem = z.output<typeof checkoutItemSchema>;

const itemsSchema = z.array(checkoutItemSchema, { error: CHECKOUT_ERRORS.emptyCart }).max(CHECKOUT_MAX_LINES, {
  message: CHECKOUT_ERRORS.tooManyLines,
});

/** Optional coupon code: trimmed and upper-cased; blank means no coupon (null). */
export const couponCodeSchema = z
  .string({ error: CHECKOUT_ERRORS.coupon })
  .max(COUPON_CODE_MAX, { message: CHECKOUT_ERRORS.coupon })
  .nullish()
  .transform((value) => {
    const code = (value ?? "").trim().toUpperCase();
    return code === "" ? null : code;
  });

/** Billing state for a quote: one of INDIAN_STATES, or blank / missing when none is chosen yet (null). */
export const billingStateSchema = z
  .union([z.enum(INDIAN_STATES), z.literal("")], { error: CHECKOUT_ERRORS.billingState })
  .nullish()
  .transform((value) => (value ? value : null));

/** POST /api/checkout/quote */
export const quoteRequestSchema = z.strictObject({
  items: itemsSchema,
  couponCode: couponCodeSchema,
  billingState: billingStateSchema,
});

export type QuoteRequest = z.output<typeof quoteRequestSchema>;

/** POST /api/checkout/orders */
export const createOrderRequestSchema = z.strictObject({
  items: itemsSchema.min(1, { message: CHECKOUT_ERRORS.emptyCart }),
  couponCode: couponCodeSchema,
  billing: billingSchema,
  createAccount: z.strictObject({ password: passwordSchema }).nullish(),
  acceptTerms: z.literal(true, { error: CHECKOUT_ERRORS.acceptTerms }),
});

export type CreateOrderRequest = z.output<typeof createOrderRequestSchema>;

/** The order link token (`?t=` / body `t`). Its signature is checked by lib/orders/token.ts. */
export const orderTokenSchema = z.string().trim().min(1).max(ORDER_TOKEN_MAX);

/** POST /api/checkout/orders/:id/cancel and /retry. */
export const orderActionRequestSchema = z.strictObject({
  t: orderTokenSchema.nullish(),
});

export type OrderActionRequest = z.output<typeof orderActionRequestSchema>;

/** POST /api/checkout/orders/:id/return: what the hosted checkout hands back to the browser. */
export const orderReturnRequestSchema = z.strictObject({
  providerPaymentId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/, { message: "The payment reference isn’t valid." }),
  providerSignature: z.string().trim().regex(/^[A-Za-z0-9+/=_-]{1,512}$/, { message: "The payment signature isn’t valid." }),
  t: orderTokenSchema.nullish(),
});

export type OrderReturnRequest = z.output<typeof orderReturnRequestSchema>;

/** True for a string shaped like an order id ("AX-10312"); anything else is answered with 404. */
export function isOrderIdShape(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}
