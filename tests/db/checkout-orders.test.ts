import { beforeAll, describe, expect, it } from "vitest";
import { resolveSession } from "@/lib/auth/sessions";
import { CHECKOUT_TERMS_VERSION, createCheckoutOrder } from "@/lib/checkout/create-order";
import { priceCart, toQuoteDto } from "@/lib/checkout/quote";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { getPaymentProvider, PaymentProviderError, type PaymentProvider } from "@/lib/payments";
import { verifyOrderToken } from "@/lib/orders/token";
import {
  buyerOf,
  existingLicense,
  makeCoupon,
  makeCustomer,
  makeStaff,
  orderRequest,
  seedCatalog,
  testIp,
  uniq,
  type CatalogFixture,
  type CustomerFixture,
} from "./checkout-fixtures";

let cat: CatalogFixture;
let owner: CustomerFixture;

beforeAll(async () => {
  cat = await seedCatalog();
  owner = await makeCustomer({ role: "OWNER" });
});

/** The real mock adapter, counting createOrder calls; `fail` makes the provider unreachable. */
function spyProvider(fail = false): PaymentProvider & { calls: number } {
  const real = getPaymentProvider("mock");
  const spy = Object.create(real) as PaymentProvider & { calls: number };
  spy.calls = 0;
  spy.createOrder = async (input) => {
    spy.calls += 1;
    if (fail) throw new PaymentProviderError("provider_error", "Provider timed out", "mock");
    return real.createOrder(input);
  };
  return spy;
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect([apiError.status, apiError.code]).toEqual([status, code]);
  return apiError;
}

describe("createCheckoutOrder", () => {
  it("creates a guest order with snapshots, line shares and a payment attempt, and no licenses", async () => {
    const code = await makeCoupon({ type: "PERCENT", value: 10 });
    const now = new Date();
    const provider = spyProvider();
    const result = await createCheckoutOrder(
      db,
      orderRequest({
        items: [
          { planId: cat.plans.annual.id, qty: 1 },
          { planId: cat.plans.perUnit.id, qty: 3 },
        ],
        couponCode: code,
      }),
      { buyer: await buyerOf(null), ip: testIp(), now, provider },
    );
    expect(provider.calls).toBe(1);
    expect(result.orderId).toMatch(/^AX-[0-9]+$/);
    expect(result.session).toBeNull();
    expect(verifyOrderToken(result.orderToken, result.orderId, now, { email: "priya@sharmamedicals.example" })).not.toBeNull();
    expect(result.statusUrl).toBe(`/orders/${result.orderId}?t=${result.orderToken}`);
    expect(result.checkout).toEqual({ kind: "mock", url: `/dev/mock-checkout?order=${result.orderId}&t=${result.orderToken}` });

    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId }, include: { items: true, payments: true } });
    expect(order).toMatchObject({
      status: "AWAITING_PAYMENT",
      accountId: null,
      placedByUserId: null,
      email: "priya@sharmamedicals.example",
      placeOfSupply: "Maharashtra",
      couponCode: code,
      termsVersion: CHECKOUT_TERMS_VERSION,
    });
    expect(order.termsAcceptedAt?.getTime()).toBe(now.getTime());
    expect(order.billing).toMatchObject({ name: "Priya Sharma", phone: "9820000000", business: "Sharma Medicals", gstin: null });
    const subtotal = 499_900 + 3 * 299_900;
    const discount = Math.round(subtotal * 0.1);
    const gst = Math.round((subtotal - discount) * 0.18);
    expect([order.subtotalPaise, order.discountPaise, order.taxablePaise, order.totalPaise]).toEqual([
      subtotal,
      discount,
      subtotal - discount,
      subtotal - discount + gst,
    ]);
    expect(order.cgstPaise + order.sgstPaise).toBe(gst);
    const sum = (k: "discountPaise" | "taxablePaise" | "taxPaise") => order.items.reduce((s, i) => s + i[k], 0);
    expect([sum("discountPaise"), sum("taxablePaise"), sum("taxPaise")]).toEqual([discount, subtotal - discount, gst]);
    expect(order.items.map((i) => [i.planId, i.quantity, i.unitPricePaise, i.kind])).toEqual(
      expect.arrayContaining([
        [cat.plans.annual.id, 1, 499_900, "NEW"],
        [cat.plans.perUnit.id, 3, 299_900, "NEW"],
      ]),
    );
    expect(order.payments).toHaveLength(1);
    expect(order.payments[0]).toMatchObject({ provider: "mock", status: "CREATED", amountPaise: order.totalPaise });
    expect(order.payments[0]?.providerOrderId).toMatch(/^order_mock_/);
    expect(await db.license.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("charges IGST for an inter-state GSTIN buyer", async () => {
    const result = await createCheckoutOrder(
      db,
      orderRequest({
        items: [{ planId: cat.plans.annual.id, qty: 1 }],
        billing: { name: "Ravi", email: "ravi@example.test", phone: "9876543210", address: "1 Main Rd", city: "Bengaluru", state: "Karnataka", pin: "560001", gstin: "29abcde1234f1z5" },
      }),
      { buyer: await buyerOf(null), ip: testIp(), provider: spyProvider() },
    );
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect([order.cgstPaise, order.sgstPaise, order.igstPaise]).toEqual([0, 0, Math.round(499_900 * 0.18)]);
    expect(order.placeOfSupply).toBe("Karnataka");
    expect(order.billing).toMatchObject({ gstin: "29ABCDE1234F1Z5", state: "Karnataka" });
  });

  it("puts a member's order on their account, including renewals of their licenses", async () => {
    const license = await existingLicense(cat.plans.annual, owner.accountId);
    const result = await createCheckoutOrder(
      db,
      orderRequest({ items: [{ planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: license.id }] }),
      { buyer: await buyerOf(owner), ip: testIp(), provider: spyProvider() },
    );
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId }, include: { items: true } });
    expect([order.accountId, order.placedByUserId]).toEqual([owner.accountId, owner.user.id]);
    expect(order.items).toMatchObject([{ kind: "RENEWAL", targetLicenseId: license.id, planId: cat.plans.annual.id }]);
  });

  it("refuses carts with invalid lines, guests renewing, staff and roles without purchases", async () => {
    const license = await existingLicense(cat.plans.annual, owner.accountId);
    const provider = spyProvider();
    const renewal = { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: license.id };
    const guest = await expectApiError(
      createCheckoutOrder(db, orderRequest({ items: [renewal] }), { buyer: await buyerOf(null), ip: testIp(), provider }),
      422,
      "cart_invalid",
    );
    expect(guest.details).toMatchObject({ issues: [{ code: "sign_in_required", planId: cat.plans.annual.id }] });
    await expectApiError(
      createCheckoutOrder(db, orderRequest({ items: [{ planId: cat.plans.trial.id, qty: 1 }] }), { buyer: await buyerOf(null), ip: testIp(), provider }),
      422,
      "cart_invalid",
    );
    const staff = await makeStaff();
    const items = [{ planId: cat.plans.annual.id, qty: 1 }];
    await expectApiError(createCheckoutOrder(db, orderRequest({ items }), { buyer: await buyerOf(staff), ip: testIp(), provider }), 403, "staff_checkout");
    const viewer = await makeCustomer({ role: "VIEWER", accountId: owner.accountId });
    await expectApiError(createCheckoutOrder(db, orderRequest({ items }), { buyer: await buyerOf(viewer), ip: testIp(), provider }), 403, "forbidden");
    expect(provider.calls).toBe(0);
  });

  it("refuses a coupon that no longer applies instead of silently charging more", async () => {
    const expired = await makeCoupon({ type: "FLAT", value: 50_000, startsAt: new Date("2026-01-01"), endsAt: new Date("2026-02-01") });
    const error = await expectApiError(
      createCheckoutOrder(db, orderRequest({ items: [{ planId: cat.plans.annual.id, qty: 1 }], couponCode: expired }), {
        buyer: await buyerOf(null),
        ip: testIp(),
        provider: spyProvider(),
      }),
      422,
      "validation_failed",
    );
    expect(error.details).toMatchObject({ fieldErrors: { couponCode: ["This code expired on 1 Feb 2026."] } });
  });

  it("stores nothing when the payment provider is unreachable", async () => {
    const email = `${uniq("down")}@example.test`;
    const provider = spyProvider(true);
    const error = await expectApiError(
      createCheckoutOrder(db, orderRequest({ items: [{ planId: cat.plans.annual.id, qty: 1 }], billing: { ...BILLING_LOWER, email } }), {
        buyer: await buyerOf(null),
        ip: testIp(),
        provider,
      }),
      502,
      "payment_unavailable",
    );
    expect(provider.calls).toBe(1);
    expect(error.message).toBe("We couldn’t reach our payment partner. Please try again in a minute.");
    expect(await db.order.count({ where: { email } })).toBe(0);
  });

  it("creates an unverified customer, account and verification code, and signs them in", async () => {
    const email = `${uniq("new")}@example.test`;
    const now = new Date();
    const result = await createCheckoutOrder(
      db,
      orderRequest({
        items: [{ planId: cat.plans.annual.id, qty: 1 }],
        billing: { ...BILLING_LOWER, email: email.toUpperCase() },
        createAccount: { password: "s3cure-pass" },
      }),
      { buyer: await buyerOf(null), ip: testIp(), now, provider: spyProvider() },
    );
    const user = await db.user.findUniqueOrThrow({ where: { email }, include: { memberships: { include: { account: true } } } });
    expect(user).toMatchObject({ kind: "CUSTOMER", emailVerifiedAt: null, name: "Priya Sharma" });
    expect(user.passwordHash).toMatch(/^[$]argon2id[$]/);
    expect(user.memberships).toMatchObject([{ role: "OWNER", status: "ACTIVE", account: { legalName: "Sharma Medicals", state: "Maharashtra" } }]);
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect([order.accountId, order.placedByUserId, order.email]).toEqual([user.memberships[0]?.accountId, user.id, email]);
    const codes = await db.authToken.findMany({ where: { userId: user.id, type: "EMAIL_VERIFY" } });
    expect(codes).toHaveLength(1);
    expect(codes[0]?.codeHash).not.toMatch(/^[0-9]{6}$/);
    expect(result.createdUserId).toBe(user.id);
    expect(result.session).not.toBeNull();
    const resolved = await resolveSession(db, result.session?.token);
    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.session.activeAccountId).toBe(order.accountId);
  });

  it("answers 409 email_taken before calling the provider when the email has an account", async () => {
    const provider = spyProvider();
    await expectApiError(
      createCheckoutOrder(
        db,
        orderRequest({ items: [{ planId: cat.plans.annual.id, qty: 1 }], billing: { ...BILLING_LOWER, email: owner.user.email }, createAccount: { password: "s3cure-pass" } }),
        { buyer: await buyerOf(null), ip: testIp(), provider },
      ),
      409,
      "email_taken",
    );
    expect(provider.calls).toBe(0);
    expect(await db.order.count({ where: { email: owner.user.email } })).toBe(0);
  });

  it("takes over the placeholder user of an invited address, and leaves the invitation pending", async () => {
    const email = `${uniq("invited")}@example.test`;
    const now = new Date();
    // What a team invitation leaves for an address without an account (lib/portal/team.ts).
    const placeholder = await db.user.create({ data: { kind: "CUSTOMER", email, name: "", passwordHash: null } });
    const invite = await db.accountMember.create({
      data: { accountId: owner.accountId, userId: placeholder.id, role: "VIEWER", status: "INVITED", invitedAt: now },
    });
    const result = await createCheckoutOrder(
      db,
      orderRequest({ items: [{ planId: cat.plans.annual.id, qty: 1 }], billing: { ...BILLING_LOWER, email }, createAccount: { password: "s3cure-pass" } }),
      { buyer: await buyerOf(null), ip: testIp(), now, provider: spyProvider() },
    );
    expect(result.createdUserId).toBe(placeholder.id);
    const user = await db.user.findUniqueOrThrow({ where: { id: placeholder.id }, include: { memberships: true } });
    expect(user).toMatchObject({ name: "Priya Sharma", phone: "9820000000", emailVerifiedAt: null });
    expect(user.passwordHash).toMatch(/^[$]argon2id[$]/);
    const own = user.memberships.find((m) => m.id !== invite.id);
    expect(own).toMatchObject({ role: "OWNER", status: "ACTIVE", invitedAt: null });
    expect(user.memberships.find((m) => m.id === invite.id)).toMatchObject({ accountId: owner.accountId, status: "INVITED" });
    expect((await db.order.findUniqueOrThrow({ where: { id: result.orderId } })).accountId).toBe(own?.accountId);
    expect(await db.authToken.count({ where: { userId: placeholder.id, type: "EMAIL_VERIFY" } })).toBe(1);
  });

  it("ignores createAccount for a signed-in customer", async () => {
    const before = await db.user.count();
    const result = await createCheckoutOrder(
      db,
      orderRequest({ items: [{ planId: cat.plans.annual.id, qty: 1 }], billing: { ...BILLING_LOWER, email: `${uniq("x")}@example.test` }, createAccount: { password: "s3cure-pass" } }),
      { buyer: await buyerOf(owner), ip: testIp(), provider: spyProvider() },
    );
    expect(result.session).toBeNull();
    expect(await db.user.count()).toBe(before);
    expect((await db.order.findUniqueOrThrow({ where: { id: result.orderId } })).accountId).toBe(owner.accountId);
  });
});

const BILLING_LOWER = {
  name: "Priya Sharma",
  email: "priya@sharmamedicals.example",
  phone: "9820000000",
  business: "Sharma Medicals",
  address: "12 MG Road",
  city: "Pune",
  state: "Maharashtra",
  pin: "411001",
};

describe("coupon redemption limits while orders are open", () => {
  const MIN = 60_000;
  async function place(code: string, now?: Date) {
    return createCheckoutOrder(
      db,
      orderRequest({ items: [{ planId: cat.plans.annual.id, qty: 1 }], couponCode: code, billing: { ...BILLING_LOWER, email: `${uniq("cpn")}@example.test` } }),
      { buyer: await buyerOf(null), ip: testIp(), provider: spyProvider(), now },
    );
  }
  const quoteCoupon = async (code: string, now: Date) =>
    toQuoteDto(await priceCart(db, { items: [{ planId: cat.plans.annual.id, qty: 1 }], couponCode: code }, await buyerOf(null), now)).coupon;
  const LIMIT_REACHED = "This code has reached its usage limit.";

  it("two concurrent orders on a single-use coupon: one is created, the other gets 422 on couponCode", async () => {
    const code = await makeCoupon({ type: "PERCENT", value: 50, maxRedemptions: 1 });
    const results = await Promise.allSettled([place(code), place(code)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused?.reason).toBeInstanceOf(ApiError);
    expect(refused?.reason).toMatchObject({ status: 422, code: "validation_failed" });
    expect((refused?.reason as ApiError).details).toMatchObject({ fieldErrors: { couponCode: [LIMIT_REACHED] } });
    expect(await db.order.count({ where: { couponCode: code } })).toBe(1);
  });

  it("an unpaid order holds its slot for an hour after its payment attempt; quotes say the code is used up meanwhile", async () => {
    const code = await makeCoupon({ type: "FLAT", value: 10_000, maxRedemptions: 1 });
    const t0 = new Date();
    const first = await place(code, t0);
    expect(await quoteCoupon(code, new Date(t0.getTime() + MIN))).toEqual({ ok: false, code, message: LIMIT_REACHED });
    await expectApiError(place(code, new Date(t0.getTime() + 30 * MIN)), 422, "validation_failed");
    // The checkout was abandoned: after the hold the slot is free again.
    expect(await quoteCoupon(code, new Date(t0.getTime() + 61 * MIN))).toMatchObject({ ok: true, code });
    const second = await place(code, new Date(t0.getTime() + 61 * MIN));
    expect(second.orderId).not.toBe(first.orderId);
  });

  it("orders whose payment is in flight hold their slot for days; canceled and failed orders hold none", async () => {
    const code = await makeCoupon({ type: "FLAT", value: 10_000, maxRedemptions: 2 });
    const t0 = new Date();
    const confirming = await place(code, t0);
    await db.order.update({ where: { id: confirming.orderId }, data: { status: "CONFIRMING" } });
    const canceled = await place(code, t0);
    await db.order.update({ where: { id: canceled.orderId }, data: { status: "CANCELED" } });
    const later = new Date(t0.getTime() + 3 * 60 * MIN);
    expect(await quoteCoupon(code, later)).toMatchObject({ ok: true });
    await place(code, later);
    expect(await quoteCoupon(code, later)).toEqual({ ok: false, code, message: LIMIT_REACHED });
  });

  it("paid orders count through Coupon.redemptions, not twice", async () => {
    const code = await makeCoupon({ type: "FLAT", value: 10_000, maxRedemptions: 2 });
    const paid = await place(code);
    await db.order.update({ where: { id: paid.orderId }, data: { status: "PAID", paidAt: new Date() } });
    await db.couponRedemption.create({ data: { couponCode: code, orderId: paid.orderId } });
    await db.coupon.update({ where: { code }, data: { redemptions: 1 } });
    await place(code);
    await expectApiError(place(code), 422, "validation_failed");
  });
});
