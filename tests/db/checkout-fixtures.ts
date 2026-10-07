/**
 * Shared fixtures for the checkout and order DB tests (tests/db/checkout-*.test.ts, tests/db/order-*.test.ts).
 * Every run uses its own ids and product codes (the test schema is shared by all DB test files of a run).
 */
import { randomBytes } from "node:crypto";
import type { License, Plan, Session, TeamRole, User } from "@/generated/prisma/client";
import { createSession } from "@/lib/auth/sessions";
import { resolveCheckoutBuyer, type CheckoutBuyer } from "@/lib/checkout/buyer";
import { db } from "@/lib/db";
import { issueLicense } from "@/lib/licensing/issue";
import { createOrderRequestSchema, type CreateOrderRequest } from "@/lib/validation/checkout";
import { freshProductCode } from "../support/product-codes";

export const tag = randomBytes(3).toString("hex");
let seq = 0;
export const uniq = (prefix: string) => `${prefix}-${tag}-${++seq}`;

/** A distinct documentation-range IP per call, so per-IP rate limits never collide between tests. */
export function testIp(): string {
  seq += 1;
  return `198.51.${Math.floor(seq / 250) % 250}.${(seq % 250) + 1}`;
}

export type CatalogFixture = {
  productId: string;
  otherProductId: string;
  hiddenProductId: string;
  plans: {
    annual: Plan;
    oneTime: Plan;
    perUnit: Plan;
    trial: Plan;
    addon: Plan;
    amc: Plan;
    archived: Plan;
    otherAnnual: Plan;
    hiddenAnnual: Plan;
  };
};

async function product(id: string, categoryId: string, status: "PUBLISHED" | "HIDDEN" | "DRAFT") {
  return db.product.create({
    data: {
      id,
      code: await freshProductCode(),
      name: `Product ${id}`,
      shortName: `P ${id}`,
      tagline: "Test product",
      summary: "Test product",
      icon: "receipt_long",
      categoryId,
      platforms: ["windows"],
      status,
      content: {},
      relatedIds: [],
    },
  });
}

type PlanInput = Pick<Plan, "productId" | "type" | "name" | "pricePaise"> &
  Partial<Pick<Plan, "interval" | "trialDays" | "deviceLimit" | "perUnit" | "maxQty" | "updatesMonths" | "archived">>;

const plan = (p: PlanInput) => db.plan.create({ data: { id: uniq("plan"), includes: [], ...p } });

/** One published product with every plan type, a second published product and a hidden one. */
export async function seedCatalog(): Promise<CatalogFixture> {
  const category = await db.category.create({ data: { id: uniq("cat"), name: "Test", tone: "peach", icon: "receipt_long" } });
  const main = await product(uniq("prod"), category.id, "PUBLISHED");
  const other = await product(uniq("prod"), category.id, "PUBLISHED");
  const hidden = await product(uniq("prod"), category.id, "HIDDEN");
  const pid = main.id;
  return {
    productId: main.id,
    otherProductId: other.id,
    hiddenProductId: hidden.id,
    plans: {
      annual: await plan({ productId: pid, type: "ANNUAL", name: "Annual license", pricePaise: 499_900, interval: "YEAR", deviceLimit: 1 }),
      oneTime: await plan({ productId: pid, type: "ONE_TIME", name: "One-time license", pricePaise: 1_299_900, deviceLimit: 1, updatesMonths: 12 }),
      perUnit: await plan({
        productId: pid, type: "ANNUAL", name: "Per-terminal license", pricePaise: 299_900, interval: "YEAR", deviceLimit: 1, perUnit: "terminal", maxQty: 10,
      }),
      trial: await plan({ productId: pid, type: "TRIAL", name: "Free trial", pricePaise: 0, trialDays: 15, deviceLimit: 1 }),
      addon: await plan({ productId: pid, type: "DEVICE_ADDON", name: "Additional computer", pricePaise: 149_900, maxQty: 10 }),
      amc: await plan({ productId: pid, type: "MAINTENANCE", name: "Maintenance & updates", pricePaise: 299_900, interval: "YEAR" }),
      archived: await plan({ productId: pid, type: "ANNUAL", name: "Old annual", pricePaise: 399_900, interval: "YEAR", deviceLimit: 1, archived: true }),
      otherAnnual: await plan({ productId: other.id, type: "ANNUAL", name: "Other annual", pricePaise: 299_900, interval: "YEAR", deviceLimit: 1 }),
      hiddenAnnual: await plan({ productId: hidden.id, type: "ANNUAL", name: "Hidden annual", pricePaise: 199_900, interval: "YEAR", deviceLimit: 1 }),
    },
  };
}

export type CustomerFixture = { user: User; session: Session; accountId: string; token: string };

/** A signed-in customer who is an ACTIVE member of a new account (or of `accountId`) with `role`. */
export async function makeCustomer(
  opts: { role?: TeamRole; verified?: boolean; accountId?: string; email?: string } = {},
): Promise<CustomerFixture> {
  const accountId = opts.accountId ?? (await db.businessAccount.create({ data: { legalName: uniq("Store") } })).id;
  const user = await db.user.create({
    data: {
      kind: "CUSTOMER",
      email: opts.email ?? `${uniq("buyer")}@example.test`,
      name: "Priya Sharma",
      emailVerifiedAt: opts.verified === false ? null : new Date(),
    },
  });
  await db.accountMember.create({ data: { accountId, userId: user.id, role: opts.role ?? "OWNER", status: "ACTIVE" } });
  const { token, session } = await createSession(db, { userId: user.id, kind: "CUSTOMER", activeAccountId: accountId });
  return { user, session, accountId, token };
}

/** A signed-in staff user. */
export async function makeStaff(): Promise<{ user: User; session: Session }> {
  const user = await db.user.create({
    data: { kind: "STAFF", email: `${uniq("staff")}@example.test`, name: "Vikram", staffRole: "ADMIN", staffStatus: "ACTIVE" },
  });
  const { session } = await createSession(db, { userId: user.id, kind: "STAFF" });
  return { user, session };
}

export const authOf = (c: { user: User; session: Session }) => ({ user: c.user, session: c.session });

export async function buyerOf(c: { user: User; session: Session } | null): Promise<CheckoutBuyer> {
  return resolveCheckoutBuyer(db, c ? authOf(c) : null);
}

/** An existing license on `plan` for `accountId`, as an earlier order or trial would have created it. */
export async function existingLicense(
  planRow: Plan,
  accountId: string | null,
  opts: { at?: Date; status?: "ACTIVE" | "TRIAL" } = {},
): Promise<License> {
  const prod = await db.product.findUniqueOrThrow({ where: { id: planRow.productId }, select: { id: true, code: true } });
  const { license } = await db.$transaction((tx) =>
    issueLicense(tx, { accountId, product: prod, plan: planRow, qty: 1, at: opts.at ?? new Date(), actor: "System", status: opts.status }),
  );
  return license;
}

export const BILLING = {
  name: "Priya Sharma",
  email: "Priya@SharmaMedicals.example",
  phone: "+91 98200 00000",
  business: "Sharma Medicals",
  address: "12 MG Road",
  city: "Pune",
  state: "Maharashtra",
  pin: "411001",
} as const;

/** A parsed POST /api/checkout/orders body (the same parsing the route does). */
export function orderRequest(overrides: Record<string, unknown> = {}): CreateOrderRequest {
  return createOrderRequestSchema.parse({ billing: { ...BILLING }, acceptTerms: true, ...overrides });
}

/** A coupon row valid around now. */
export async function makeCoupon(data: {
  type: "PERCENT" | "FLAT";
  value: number;
  minSubtotal?: number | null;
  productIds?: string[];
  planTypes?: Plan["type"][];
  startsAt?: Date;
  endsAt?: Date;
  active?: boolean;
  maxRedemptions?: number | null;
  redemptions?: number;
}): Promise<string> {
  const code = uniq("CK").toUpperCase().replace(/-/g, "");
  await db.coupon.create({
    data: {
      code,
      type: data.type,
      value: data.value,
      label: `${data.value} off`,
      minSubtotal: data.minSubtotal ?? null,
      productIds: data.productIds ?? [],
      planTypes: data.planTypes ?? [],
      startsAt: data.startsAt ?? new Date(Date.now() - 86_400_000),
      endsAt: data.endsAt ?? new Date(Date.now() + 86_400_000),
      active: data.active ?? true,
      maxRedemptions: data.maxRedemptions ?? null,
      redemptions: data.redemptions ?? 0,
    },
  });
  return code;
}

/** Places an order through createCheckoutOrder with the mock provider (one annual license unless `items` given). */
export async function placeOrder(
  who: { user: User; session: Session } | null,
  opts: { items?: unknown[]; email?: string; now?: Date; couponCode?: string } = {},
) {
  const { createCheckoutOrder } = await import("@/lib/checkout/create-order");
  const { getPaymentProvider } = await import("@/lib/payments");
  const items = opts.items ?? [{ planId: (await anyAnnualPlan()).id, qty: 1 }];
  return createCheckoutOrder(
    db,
    orderRequest({
      items,
      billing: { ...BILLING, email: opts.email ?? BILLING.email },
      ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
    }),
    { buyer: await buyerOf(who), ip: testIp(), now: opts.now, provider: getPaymentProvider("mock") },
  );
}

let annualPlanCache: Plan | null = null;
async function anyAnnualPlan(): Promise<Plan> {
  annualPlanCache ??= (await seedCatalog()).plans.annual;
  return annualPlanCache;
}

/** What the verified webhook does on payment.captured: mark PAID and fulfil the items (licenses issued). */
export async function markPaid(orderId: string, paidAt: Date = new Date()): Promise<void> {
  const { fulfilOrderItems } = await import("@/lib/licensing/fulfil");
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.update({ where: { id: orderId }, data: { status: "PAID", paidAt } });
    await tx.payment.updateMany({ where: { orderId, status: { in: ["CREATED", "AUTHORIZED"] } }, data: { status: "CAPTURED", capturedAt: paidAt } });
    await fulfilOrderItems(tx, { id: order.id, accountId: order.accountId, paidAt });
  });
}
