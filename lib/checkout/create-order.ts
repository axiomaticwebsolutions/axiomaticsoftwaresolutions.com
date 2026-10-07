/**
 * POST /api/checkout/orders (api-contracts section 3, decisions.md Phase 3 "Checkout and orders").
 *
 * 1. Buyer rules: staff cannot place customer orders; members need the `purchases` team permission.
 * 2. Re-prices the cart from server data only (quote.ts); any refused line -> 422 `cart_invalid` with `issues`;
 *    a coupon that no longer applies -> 422 with the coupon message on `couponCode` (the buyer never pays more than
 *    the total they were shown without being told).
 * 3. "Create an account" (guests only): register rate limit, 409 `email_taken`, argon2id hash, all before any write.
 * 4. Allocates the order id (its own short transaction; order ids may have gaps, invoice numbers may not), then calls
 *    the payment provider OUTSIDE any transaction. Provider failure -> 502 `payment_unavailable`, nothing stored.
 * 5. One transaction: the coupon row locked and re-checked against the slots unpaid orders hold
 *    (lib/checkout/coupon-hold; a code used up meanwhile -> 422 on `couponCode`), optional customer + account + OWNER
 *    membership + verification code, Order(AWAITING_PAYMENT)
 *    with the billing snapshot, price snapshot and per-line discount/taxable/tax shares, terms acceptance, and
 *    Payment(CREATED) with the provider order id. So an order never exists without a payment attempt.
 * 6. After commit: the verification email (lib/auth/flows/verify-email) and a session for the new customer.
 */
import { OrderStatus, PaymentStatus } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { isPlaceholderUser } from "@/lib/auth/flows/common";
import { sendVerificationEmail } from "@/lib/auth/flows/verify-email";
import { hashPassword } from "@/lib/auth/password";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { createSession } from "@/lib/auth/sessions";
import { nextOrderId } from "@/lib/counters";
import { Prisma } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { getPaymentProvider, type PaymentProvider } from "@/lib/payments";
import { billingSnapshot } from "@/lib/orders/billing";
import { teamCan } from "@/lib/rbac";
import type { CreateOrderRequest } from "@/lib/validation/checkout";
import { LEGAL_DOCUMENTS } from "@/content/legal/documents";
import { createCheckoutCustomer, EMAIL_TAKEN_MESSAGE, type CheckoutCustomer } from "./account";
import { buyerUserId, PURCHASE_FORBIDDEN_MESSAGE, purchasingAccountId, STAFF_CHECKOUT_MESSAGE, type CheckoutBuyer } from "./buyer";
import { couponAvailability, lockCoupon } from "./coupon-hold";
import { checkoutStart, createProviderOrder, type CheckoutStart } from "./payment-attempt";
import { priceCart } from "./quote";

export const CART_INVALID_MESSAGE = "Some items in your cart can’t be bought as they are. Review your cart and try again.";
export const ZERO_TOTAL_MESSAGE = "This order has nothing to pay. Remove the coupon or contact us to complete it.";

/** The documents the buyer accepts with "I agree to the License agreement, Terms and Refund policy.". */
export const CHECKOUT_TERMS_VERSION = (["terms", "eula", "refund"] as const)
  .map((slug) => `${slug}@${LEGAL_DOCUMENTS[slug].version}`)
  .join(",");

export type CreateOrderContext = {
  buyer: CheckoutBuyer;
  ip: string | null;
  userAgent?: string | null;
  now?: Date;
  /** Defaults to getPaymentProvider() (PAYMENT_PROVIDER). */
  provider?: PaymentProvider;
};

export type CreatedOrder = CheckoutStart & {
  /** Set when "Create an account" signed the buyer in: the route sets the session and CSRF cookies. */
  session: { id: string; token: string; expiresAt: Date } | null;
  /** The new customer's user id (createAccount), else null. */
  createdUserId: string | null;
};

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createCheckoutOrder(
  db: PrismaClient,
  input: CreateOrderRequest,
  ctx: CreateOrderContext,
): Promise<CreatedOrder> {
  const now = ctx.now ?? new Date();
  const { buyer } = ctx;
  if (buyer.kind === "staff") throw errors.forbidden(STAFF_CHECKOUT_MESSAGE, "staff_checkout");
  if (buyer.kind === "customer" && buyer.membership && !teamCan(buyer.membership.role, "purchases")) {
    throw errors.forbidden(PURCHASE_FORBIDDEN_MESSAGE);
  }

  const billing = billingSnapshot(input.billing);
  const priced = await priceCart(db, { items: input.items, couponCode: input.couponCode, billingState: billing.state }, buyer, now);
  if (priced.issues.length > 0) {
    throw new ApiError(422, "cart_invalid", CART_INVALID_MESSAGE, { details: { issues: priced.issues } });
  }
  const q = priced.quote;
  if (q.coupon && !q.coupon.ok) throw errors.validation({ couponCode: q.coupon.message });
  if (q.lines.length === 0) throw errors.validation({ items: "Your cart is empty." });
  if (q.totalPaise <= 0) throw new ApiError(422, "zero_total", ZERO_TOTAL_MESSAGE);

  let passwordHash: string | null = null;
  if (buyer.kind === "guest" && input.createAccount) {
    enforce(await hit(db, RATE_LIMITS.register(ctx.ip), now));
    // An invited address's placeholder user is taken over in the order transaction (createCheckoutCustomer).
    const existing = await db.user.findUnique({
      where: { email: billing.email },
      select: { kind: true, passwordHash: true, emailVerifiedAt: true },
    });
    if (existing && !isPlaceholderUser(existing)) throw errors.conflict("email_taken", EMAIL_TAKEN_MESSAGE);
    passwordHash = await hashPassword(input.createAccount.password);
  }

  const couponCode = q.coupon?.ok ? q.coupon.code : null;
  const provider = ctx.provider ?? getPaymentProvider();
  const orderId = await db.$transaction((tx) => nextOrderId(tx));
  const providerOrder = await createProviderOrder(provider, {
    id: orderId,
    totalPaise: q.totalPaise,
    email: billing.email,
    phone: billing.phone,
  });

  let customer: CheckoutCustomer | null = null;
  try {
    customer = await db.$transaction(async (tx) => {
      if (couponCode) {
        // The coupon's slot is taken here: concurrent checkouts queue on the coupon row and see this order's hold.
        await lockCoupon(tx, couponCode);
        const available = await couponAvailability(tx, couponCode, { now });
        if (!available.ok) throw errors.validation({ couponCode: available.message });
      }
      const created = passwordHash ? await createCheckoutCustomer(tx, { billing, passwordHash, now, next: `/orders/${orderId}` }) : null;
      await tx.order.create({
        data: {
          id: orderId,
          accountId: created ? created.account.id : purchasingAccountId(buyer),
          placedByUserId: created ? created.user.id : buyerUserId(buyer),
          email: billing.email,
          billing,
          status: OrderStatus.AWAITING_PAYMENT,
          couponCode,
          subtotalPaise: q.subtotalPaise,
          discountPaise: q.discountPaise,
          taxablePaise: q.taxablePaise,
          cgstPaise: q.cgstPaise,
          sgstPaise: q.sgstPaise,
          igstPaise: q.igstPaise,
          totalPaise: q.totalPaise,
          placeOfSupply: billing.state,
          termsAcceptedAt: now,
          termsVersion: CHECKOUT_TERMS_VERSION,
          createdAt: now,
          items: {
            create: q.lines.map((line) => ({
              planId: line.planId,
              kind: line.kind,
              quantity: line.qty,
              unitPricePaise: line.unitPricePaise,
              creditPaise: line.creditPaise,
              discountPaise: line.discountPaise,
              taxablePaise: line.taxablePaise,
              taxPaise: line.taxPaise,
              targetLicenseId: line.targetLicenseId,
            })),
          },
        },
      });
      await tx.payment.create({
        data: {
          orderId,
          provider: provider.key,
          providerOrderId: providerOrder.providerOrderId,
          amountPaise: q.totalPaise,
          status: PaymentStatus.CREATED,
          createdAt: now,
        },
      });
      return created;
    });
  } catch (error) {
    // The only realistic unique violation is a concurrent registration with the same email.
    if (passwordHash && isUniqueViolation(error)) throw errors.conflict("email_taken", EMAIL_TAKEN_MESSAGE);
    throw error;
  }

  let session: CreatedOrder["session"] = null;
  if (customer) {
    await sendCheckoutVerification(customer);
    const created = await createSession(db, {
      userId: customer.user.id,
      kind: "CUSTOMER",
      userAgent: ctx.userAgent ?? null,
      ip: ctx.ip,
      activeAccountId: customer.account.id,
      now,
    });
    session = { id: created.session.id, token: created.token, expiresAt: created.session.expiresAt };
  }

  log.info("order_created", {
    orderId,
    lines: q.lines.length,
    totalPaise: q.totalPaise,
    provider: provider.key,
    accountOrder: customer !== null || purchasingAccountId(buyer) !== null,
    newCustomer: customer !== null,
  });
  return {
    ...checkoutStart({ id: orderId, totalPaise: q.totalPaise, billing }, provider.key, providerOrder, billing.email, now),
    session,
    createdUserId: customer?.user.id ?? null,
  };
}

/** Emails the verification code after commit. Never throws: the customer can always ask for a new code. */
async function sendCheckoutVerification(customer: CheckoutCustomer): Promise<void> {
  try {
    await sendVerificationEmail(customer.user, customer.verificationCode);
  } catch (error) {
    log.warn("checkout_verification_email_failed", { userId: customer.user.id, error });
  }
}
