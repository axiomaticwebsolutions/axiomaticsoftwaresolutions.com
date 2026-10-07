/**
 * Fixtures for the admin orders and refund DB tests (tests/db/admin-orders-*.test.ts, admin-refund-*.test.ts): a small
 * catalog, business accounts, orders paid through the real webhook handler with the mock provider, and licenses.
 * Not a test file. Every id is unique per run (DB test files share one schema).
 */
import { randomBytes, randomInt } from "node:crypto";
import type { ItemKind, License, LicenseStatus, Plan } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { issueLicense } from "@/lib/licensing/issue";
import { mockCapture } from "@/lib/payments/mock";
import { processPaymentEvent } from "@/lib/payments/webhook";
import { freshProductCode } from "../support/product-codes";

export const fxTag = randomBytes(3).toString("hex");
let seq = 0;
const next = () => (seq += 1);

export type OrdersCatalog = {
  product: { id: string; code: string; name: string; shortName: string };
  plans: { annual: Plan; oneTime: Plan; addon: Plan; trial: Plan };
};

export async function makeOrdersCatalog(): Promise<OrdersCatalog> {
  const n = next();
  const category = await db.category.create({ data: { id: `aocat-${fxTag}-${n}`, name: "Test", tone: "peach", icon: "receipt_long" } });
  const product = await db.product.create({
    data: {
      id: `ao-${fxTag}-${n}`,
      code: await freshProductCode(),
      name: `Refund Billing ${fxTag}${n}`,
      shortName: "Refund",
      tagline: "Test product",
      summary: "Test product",
      icon: "receipt_long",
      categoryId: category.id,
      platforms: ["windows"],
      status: "PUBLISHED",
      content: {},
      relatedIds: [],
    },
    select: { id: true, code: true, name: true, shortName: true },
  });
  const plan = (p: Pick<Plan, "id" | "type" | "name" | "pricePaise"> & Partial<Plan>) =>
    db.plan.create({ data: { includes: [], productId: product.id, ...p } });
  return {
    product,
    plans: {
      annual: await plan({ id: `ao-annual-${fxTag}-${n}`, type: "ANNUAL", name: "Annual license", interval: "YEAR", pricePaise: 499_900, deviceLimit: 1 }),
      oneTime: await plan({ id: `ao-once-${fxTag}-${n}`, type: "ONE_TIME", name: "One-time license", pricePaise: 1_299_900, deviceLimit: 1, updatesMonths: 12 }),
      addon: await plan({ id: `ao-addon-${fxTag}-${n}`, type: "DEVICE_ADDON", name: "Extra computer", pricePaise: 99_900, deviceLimit: null }),
      trial: await plan({ id: `ao-trial-${fxTag}-${n}`, type: "TRIAL", name: "Free trial", pricePaise: 0, trialDays: 14, deviceLimit: 1 }),
    },
  };
}

export type TestAccount = { accountId: string; ownerId: string; ownerEmail: string };

/** A business account with an active owner (gets the refund notification). */
export async function makeOrdersAccount(): Promise<TestAccount> {
  const n = next();
  const account = await db.businessAccount.create({ data: { legalName: `Refund Stores ${fxTag}-${n}` } });
  const owner = await db.user.create({
    data: { email: `ao-owner-${fxTag}-${n}@example.test`, name: `Owner ${n}`, emailVerifiedAt: new Date() },
  });
  await db.accountMember.create({ data: { accountId: account.id, userId: owner.id, role: "OWNER" } });
  return { accountId: account.id, ownerId: owner.id, ownerEmail: owner.email };
}

export type ItemSpec = { plan: Plan; quantity?: number; kind?: ItemKind; target?: string };
export type PlacedOrder = { id: string; email: string; totalPaise: number; paymentId: string; providerOrderId: string };

/** An order (CONFIRMING) with one mock payment attempt; intra-state GST (CGST + SGST). */
export async function placeOrder(spec: { accountId?: string | null; items: ItemSpec[]; couponCode?: string | null; business?: string }): Promise<PlacedOrder> {
  const n = next();
  const id = `AX-${randomInt(10_000_000, 99_999_999)}`;
  const subtotal = spec.items.reduce((sum, i) => sum + i.plan.pricePaise * (i.quantity ?? 1), 0);
  const gst = Math.round((subtotal * 18) / 100);
  const cgst = Math.round(gst / 2);
  const totalPaise = subtotal + gst;
  const email = `ao-buyer-${fxTag}-${n}@example.test`;
  const providerOrderId = `order_mock_ao${fxTag}${n}`;
  await db.order.create({
    data: {
      id,
      accountId: spec.accountId ?? null,
      email,
      billing: {
        name: "Priya Sharma",
        email,
        phone: "9820000000",
        business: spec.business ?? `Sharma Medicals ${fxTag}`,
        address: "Shop 4",
        city: "Pune",
        state: "Maharashtra",
        pin: "411004",
        gstin: null,
      },
      status: "CONFIRMING",
      couponCode: spec.couponCode ?? null,
      subtotalPaise: subtotal,
      taxablePaise: subtotal,
      cgstPaise: cgst,
      sgstPaise: gst - cgst,
      totalPaise,
      placeOfSupply: "Maharashtra",
      items: {
        create: spec.items.map((i) => ({
          planId: i.plan.id,
          kind: i.kind ?? "NEW",
          quantity: i.quantity ?? 1,
          unitPricePaise: i.plan.pricePaise,
          taxablePaise: i.plan.pricePaise * (i.quantity ?? 1),
          taxPaise: Math.round((i.plan.pricePaise * (i.quantity ?? 1) * 18) / 100),
          targetLicenseId: i.target ?? null,
        })),
      },
      payments: { create: { provider: "mock", providerOrderId, amountPaise: totalPaise } },
    },
  });
  const payment = await db.payment.findUniqueOrThrow({ where: { providerOrderId }, select: { id: true } });
  return { id, email, totalPaise, paymentId: payment.id, providerOrderId };
}

export type PaidOrder = PlacedOrder & { providerPaymentId: string; eventId: string; licenseIds: string[] };

/** Captures the order's payment in the mock ledger and applies payment.captured through processPaymentEvent. */
export async function payOrder(order: PlacedOrder, at: Date = new Date()): Promise<PaidOrder> {
  const captured = mockCapture(order.providerOrderId, order.totalPaise, "UPI");
  const eventId = `evt_mock_ao${fxTag}${next()}`;
  const { result } = await processPaymentEvent(
    "mock",
    {
      id: eventId,
      type: "payment.captured",
      providerOrderId: order.providerOrderId,
      providerPaymentId: captured.providerPaymentId,
      amountPaise: order.totalPaise,
      currency: "INR",
      method: "UPI",
      occurredAt: at,
    },
    { now: at },
  );
  if (result !== "fulfilled") throw new Error(`Order ${order.id} was not fulfilled: ${result}`);
  const licenses = await db.license.findMany({ where: { orderId: order.id }, select: { id: true }, orderBy: { id: "asc" } });
  return { ...order, providerPaymentId: captured.providerPaymentId, eventId, licenseIds: licenses.map((l) => l.id) };
}

export async function paidOrder(spec: Parameters<typeof placeOrder>[0], at?: Date): Promise<PaidOrder> {
  return payOrder(await placeOrder(spec), at);
}

/** A license issued outside any order (the target of renewals, add-ons and upgrades). */
export async function issueTestLicense(
  accountId: string,
  catalog: OrdersCatalog,
  plan: Plan,
  at: Date,
  status?: Extract<LicenseStatus, "ACTIVE" | "TRIAL">,
): Promise<License> {
  return db.$transaction(async (tx) => {
    const { license } = await issueLicense(tx, { accountId, product: catalog.product, plan, qty: 1, at, actor: "System", ...(status ? { status } : {}) });
    return license;
  });
}

/** The license's refund-relevant terms, for exact before/after comparisons. */
export async function licenseTerms(id: string) {
  return db.license.findUniqueOrThrow({
    where: { id },
    select: { planId: true, status: true, expiresAt: true, updatesUntil: true, deviceLimit: true, revokedAt: true, revokedReason: true },
  });
}

/** Active devices on a license, each seen at a different time (oldest first). */
export async function addDevices(licenseId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const device = await db.deviceActivation.create({
      data: {
        licenseId,
        fingerprint: `fp-${fxTag}-${next()}`,
        name: `PC ${i + 1}`,
        os: "Windows 11",
        lastSeenAt: new Date(Date.now() - (count - i) * 60_000),
      },
    });
    ids.push(device.id);
  }
  return ids;
}

/** Applies refund.processed for a refund (as the mock provider's webhook would). */
export async function processRefund(order: PaidOrder, providerRefundId: string, amountPaise: number) {
  return processPaymentEvent("mock", {
    id: `evt_mock_rf${fxTag}${next()}`,
    type: "refund.processed",
    providerOrderId: order.providerOrderId,
    providerPaymentId: order.providerPaymentId,
    providerRefundId,
    amountPaise,
    currency: "INR",
  });
}
