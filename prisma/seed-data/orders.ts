/**
 * Turns sample order drafts into Order / OrderItem / Payment / CouponRedemption rows. Every amount comes from
 * lib/pricing quote() (GST split intra- vs inter-state by billing state, coupon discount and GST allocated to the
 * lines by largest remainder), exactly as the checkout will price real orders.
 */
import type { Prisma } from "@/generated/prisma/client";
import { OrderStatus, PaymentStatus, type ItemKind } from "@/generated/prisma/enums";
import { quote, type CouponRule, type PricingPlan, type Quote, type TaxSettings } from "@/lib/pricing";
import type { IndianState } from "@/lib/validation/states";
import { orderNumber, seedIds } from "./ids";
import type { WithId } from "./types";

/** Order.billing snapshot, the same keys checkout stores (gstin omitted when the buyer has none). */
export type BillingSnapshot = {
  name: string;
  email: string;
  phone: string;
  business: string;
  address: string;
  city: string;
  state: IndianState;
  pin: string;
  gstin?: string;
};

export type OrderLineDraft = {
  planId: string;
  qty: number;
  kind: ItemKind;
  targetLicenseId?: string | null;
  issuedLicenseId?: string | null;
};

export type OrderDraft = {
  id: string;
  accountId: string | null;
  placedByUserId: string | null;
  billing: BillingSnapshot;
  status: OrderStatus;
  createdAt: Date;
  paidAt: Date | null;
  refundedAt: Date | null;
  /** A coupon the caller has already checked is valid for this cart at createdAt. */
  coupon: CouponRule | null;
  lines: OrderLineDraft[];
  method: string;
};

export type PricingContext = {
  plans: ReadonlyMap<string, PricingPlan>;
  tax: TaxSettings;
};

export type OrderBundle = {
  order: WithId<Prisma.OrderCreateManyInput>;
  items: WithId<Prisma.OrderItemCreateManyInput>[];
  payment: WithId<Prisma.PaymentCreateManyInput>;
  redemption: WithId<Prisma.CouponRedemptionCreateManyInput> | null;
  quote: Quote;
};

export const SAMPLE_PAYMENT_PROVIDER = "mock";
export const SAMPLE_TERMS_VERSION = "sample";
export const PAYMENT_DECLINED = "Your bank declined the payment.";

const PAYMENT_STATUS: Record<OrderStatus, PaymentStatus> = {
  AWAITING_PAYMENT: PaymentStatus.CREATED,
  CONFIRMING: PaymentStatus.AUTHORIZED,
  PENDING: PaymentStatus.PENDING,
  PAID: PaymentStatus.CAPTURED,
  FAILED: PaymentStatus.FAILED,
  CANCELED: PaymentStatus.CANCELED,
  REFUNDED: PaymentStatus.REFUNDED,
  PARTIALLY_REFUNDED: PaymentStatus.CAPTURED,
  REVIEW: PaymentStatus.CAPTURED,
};

const latest = (...dates: (Date | null)[]): Date =>
  new Date(Math.max(...dates.filter((d): d is Date => d !== null).map((d) => d.getTime())));

/** Prices the draft with quote() and builds its rows. Throws if the coupon does not apply. */
export function buildOrderBundle(draft: OrderDraft, ctx: PricingContext): OrderBundle {
  const priced = quote({
    lines: draft.lines.map((l) => ({ planId: l.planId, qty: l.qty, kind: l.kind, targetLicenseId: l.targetLicenseId ?? null })),
    plans: ctx.plans,
    tax: ctx.tax,
    billingState: draft.billing.state,
    couponCode: draft.coupon?.code ?? null,
    coupon: draft.coupon,
    now: draft.createdAt,
  });
  if (draft.coupon && !priced.coupon?.ok) throw new Error(`Coupon ${draft.coupon.code} does not apply to ${draft.id}`);

  const settled = draft.status === OrderStatus.PAID || draft.status === OrderStatus.REFUNDED;
  const num = orderNumber(draft.id);
  const order: OrderBundle["order"] = {
    id: draft.id,
    accountId: draft.accountId,
    placedByUserId: draft.placedByUserId,
    email: draft.billing.email,
    billing: draft.billing,
    status: draft.status,
    couponCode: draft.coupon ? draft.coupon.code : null,
    subtotalPaise: priced.subtotalPaise,
    discountPaise: priced.discountPaise,
    taxablePaise: priced.taxablePaise,
    cgstPaise: priced.cgstPaise,
    sgstPaise: priced.sgstPaise,
    igstPaise: priced.igstPaise,
    totalPaise: priced.totalPaise,
    placeOfSupply: draft.billing.state,
    failReason: draft.status === OrderStatus.FAILED ? PAYMENT_DECLINED : null,
    termsAcceptedAt: draft.createdAt,
    termsVersion: SAMPLE_TERMS_VERSION,
    createdAt: draft.createdAt,
    updatedAt: latest(draft.createdAt, draft.paidAt, draft.refundedAt),
    paidAt: settled ? draft.paidAt : null,
    refundedAt: draft.status === OrderStatus.REFUNDED ? draft.refundedAt : null,
  };

  const items = priced.lines.map((line, i): OrderBundle["items"][number] => {
    const source = draft.lines[i];
    return {
      id: seedIds.orderItem(draft.id, i + 1),
      orderId: draft.id,
      planId: line.planId,
      kind: line.kind,
      quantity: line.qty,
      unitPricePaise: line.unitPricePaise,
      creditPaise: line.creditPaise,
      discountPaise: line.discountPaise,
      taxablePaise: line.taxablePaise,
      taxPaise: line.taxPaise,
      targetLicenseId: line.targetLicenseId,
      issuedLicenseId: settled ? (source?.issuedLicenseId ?? null) : null,
      fulfilledAt: settled ? draft.paidAt : null,
    };
  });

  const paymentStatus = PAYMENT_STATUS[draft.status];
  const payment: OrderBundle["payment"] = {
    id: seedIds.payment(draft.id),
    orderId: draft.id,
    provider: SAMPLE_PAYMENT_PROVIDER,
    providerOrderId: `order_SAMPLE_${num}`,
    providerPaymentId: paymentStatus === PaymentStatus.CANCELED ? null : `pay_SAMPLE_${num}`,
    method: draft.method,
    amountPaise: priced.totalPaise,
    status: paymentStatus,
    failureReason: paymentStatus === PaymentStatus.FAILED ? PAYMENT_DECLINED : null,
    createdAt: draft.createdAt,
    capturedAt: settled ? draft.paidAt : null,
  };

  const redemption: OrderBundle["redemption"] =
    settled && draft.coupon
      ? {
          id: seedIds.redemption(draft.id),
          couponCode: draft.coupon.code,
          orderId: draft.id,
          accountId: draft.accountId,
          createdAt: draft.paidAt ?? draft.createdAt,
        }
      : null;

  return { order, items, payment, redemption, quote: priced };
}
