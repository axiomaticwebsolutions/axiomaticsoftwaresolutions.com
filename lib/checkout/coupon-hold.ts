/**
 * Coupon redemption limits (Coupon.maxRedemptions) must hold while orders are open. Coupon.redemptions only counts paid
 * orders (the webhook redeems at payment), so an unpaid order holds one slot of its coupon while it can still be paid:
 * - AWAITING_PAYMENT: for COUPON_HOLD_AWAITING_MS after its latest payment attempt (one checkout session);
 * - PENDING and CONFIRMING (money in flight) and REVIEW (money taken, staff decide): for COUPON_HOLD_SETTLING_MS.
 * Quotes count held slots; order creation and "Try again" lock the coupon row (SELECT ... FOR UPDATE) inside their
 * transaction and require `redemptions + held < maxRedemptions`, so concurrent checkouts cannot both take the last
 * slot. A retry also re-checks that the coupon is still active and within its dates. An order paid after its hold
 * lapsed is still honoured (the webhook never refuses money already taken and logs coupon_redemptions_exceeded); a
 * lapsed AWAITING_PAYMENT order gets a fresh attempt, and so a fresh check, instead of reopening the old one.
 * Short holds for unpaid checkouts keep a limited coupon from being tied up by orders nobody pays.
 */
import { OrderStatus } from "@/generated/prisma/enums";
import { DAY_MS } from "@/lib/dates";
import type { Db, Tx } from "@/lib/db";
import { COUPON_MESSAGES, normalizeCouponCode, type CouponFailure } from "@/lib/pricing";

export const COUPON_HOLD_AWAITING_MS = 60 * 60_000;
export const COUPON_HOLD_SETTLING_MS = 7 * DAY_MS;

const SETTLING: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.CONFIRMING, OrderStatus.REVIEW];

/** Unpaid orders currently holding a slot of `code` (not yet counted in Coupon.redemptions). */
export async function heldCouponSlots(
  client: Db,
  code: string,
  opts: { now: Date; excludeOrderId?: string | null },
): Promise<number> {
  const t = opts.now.getTime();
  const holding = await client.order.findMany({
    where: {
      couponCode: code,
      ...(opts.excludeOrderId ? { id: { not: opts.excludeOrderId } } : {}),
      OR: [
        {
          status: OrderStatus.AWAITING_PAYMENT,
          payments: { some: { createdAt: { gt: new Date(t - COUPON_HOLD_AWAITING_MS) } } },
        },
        { status: { in: SETTLING }, payments: { some: { createdAt: { gt: new Date(t - COUPON_HOLD_SETTLING_MS) } } } },
      ],
    },
    select: { id: true },
  });
  if (holding.length === 0) return 0;
  // A REVIEW order may already have been redeemed (e.g. after staff completed it).
  const redeemed = await client.couponRedemption.count({ where: { orderId: { in: holding.map((o) => o.id) } } });
  return holding.length - redeemed;
}

/**
 * Locks a limited coupon's row until the caller's transaction ends, so order creation and retries that could take its
 * last slot queue here. Unlimited coupons have no slots to race for and are not locked.
 */
export async function lockCoupon(tx: Tx, code: string): Promise<void> {
  await tx.$queryRaw`SELECT "code" FROM "Coupon" WHERE "code" = ${normalizeCouponCode(code)} AND "maxRedemptions" IS NOT NULL FOR UPDATE`;
}

export type CouponAvailability = { ok: true } | { ok: false; reason: CouponFailure; message: string };

/**
 * Whether `code` can be used for an order now, independent of the cart: the coupon exists, is active, is within its
 * dates and has a free slot once held slots are counted (`excludeOrderId`: the order being retried). Lock the row
 * first (lockCoupon) when the answer decides a write.
 */
export async function couponAvailability(
  client: Db,
  rawCode: string,
  opts: { now: Date; excludeOrderId?: string | null },
): Promise<CouponAvailability> {
  const code = normalizeCouponCode(rawCode);
  const coupon = code === "" ? null : await client.coupon.findUnique({ where: { code } });
  // A paused code reads exactly like an unknown one, so codes cannot be probed.
  if (!coupon) return { ok: false, reason: "not_found", message: COUPON_MESSAGES.invalid };
  if (!coupon.active) return { ok: false, reason: "paused", message: COUPON_MESSAGES.invalid };
  const t = opts.now.getTime();
  if (t < coupon.startsAt.getTime()) return { ok: false, reason: "not_started", message: COUPON_MESSAGES.startsOn(coupon.startsAt) };
  if (t > coupon.endsAt.getTime()) return { ok: false, reason: "expired", message: COUPON_MESSAGES.expiredOn(coupon.endsAt) };
  if (coupon.maxRedemptions !== null) {
    const held = await heldCouponSlots(client, coupon.code, opts);
    if (coupon.redemptions + held >= coupon.maxRedemptions) {
      return { ok: false, reason: "limit_reached", message: COUPON_MESSAGES.limitReached };
    }
  }
  return { ok: true };
}
