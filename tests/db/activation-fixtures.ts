/**
 * Shared fixtures for the activation API DB tests (tests/db/activation-*.test.ts). Licenses are issued with the env
 * secrets (getLicenseKeySecrets), which the activation service uses for its key lookups. Every run uses its own ids,
 * product codes, fingerprints and client IPs (the test schema is shared by all DB test files of a run).
 */
import { randomBytes } from "node:crypto";
import type { License, Plan } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { fulfilOrderItems } from "@/lib/licensing/fulfil";
import { issueLicense } from "@/lib/licensing/issue";
import { activateRequestSchema, type ActivateRequest } from "@/lib/validation/activation";
import { freshProductCode } from "../support/product-codes";

export const tag = randomBytes(3).toString("hex");
let seq = 0;
export const uniq = (prefix: string) => `${prefix}-${tag}-${++seq}`;

/** A fresh SHA-256-shaped device fingerprint. */
export const newFingerprint = () => randomBytes(32).toString("hex");

const ipBase = randomBytes(1)[0] ?? 0;
let ipSeq = 0;
/** A distinct TEST-NET-3 address per call, so per-IP buckets never collide between tests. */
export function nextIp(): string {
  ipSeq += 1;
  return `203.0.${(ipBase + Math.floor(ipSeq / 250)) % 256}.${(ipSeq % 250) + 1}`;
}

export type Product = { id: string; code: string };
export type ActivationCatalog = {
  product: Product;
  other: Product;
  plans: { annual: Plan; multi: Plan; oneTime: Plan; trial: Plan; subscription: Plan };
};

async function makeProduct(categoryId: string): Promise<Product> {
  const id = uniq("act-prod");
  return db.product.create({
    data: {
      id,
      code: await freshProductCode(),
      name: `Product ${id}`,
      shortName: id,
      tagline: "Test product",
      summary: "Test product",
      icon: "receipt_long",
      categoryId,
      platforms: ["windows"],
      status: "PUBLISHED",
      content: {},
      relatedIds: [],
    },
    select: { id: true, code: true },
  });
}

type PlanInput = Pick<Plan, "productId" | "type" | "name"> &
  Partial<Pick<Plan, "interval" | "trialDays" | "deviceLimit" | "perUnit" | "updatesMonths">>;
const makePlan = (p: PlanInput) =>
  db.plan.create({ data: { id: uniq("act-plan"), includes: [], pricePaise: p.type === "TRIAL" ? 0 : 100_000, ...p } });

export async function seedActivationCatalog(): Promise<ActivationCatalog> {
  const category = await db.category.create({ data: { id: uniq("act-cat"), name: "Test", tone: "peach", icon: "receipt_long" } });
  const product = await makeProduct(category.id);
  const other = await makeProduct(category.id);
  const pid = product.id;
  return {
    product,
    other,
    plans: {
      annual: await makePlan({ productId: pid, type: "ANNUAL", name: "Annual", interval: "YEAR", deviceLimit: 1 }),
      multi: await makePlan({ productId: pid, type: "ANNUAL", name: "Annual, 3 computers", interval: "YEAR", deviceLimit: 3 }),
      oneTime: await makePlan({ productId: pid, type: "ONE_TIME", name: "One-time", deviceLimit: 1, updatesMonths: 12 }),
      trial: await makePlan({ productId: pid, type: "TRIAL", name: "Free trial", trialDays: 15, deviceLimit: 1 }),
      subscription: await makePlan({ productId: pid, type: "SUBSCRIPTION", name: "Monthly", interval: "MONTH", deviceLimit: 1 }),
    },
  };
}

export const newAccount = async () => (await db.businessAccount.create({ data: { legalName: uniq("Store") } })).id;

/** Issues a license on `plan` (env secrets) and returns it with its plaintext key. */
export async function issue(
  cat: ActivationCatalog,
  plan: Plan,
  opts: { accountId?: string | null; at?: Date; status?: "ACTIVE" | "TRIAL" } = {},
): Promise<{ license: License; key: string }> {
  const product = plan.productId === cat.product.id ? cat.product : cat.other;
  return db.$transaction((tx) =>
    issueLicense(tx, {
      accountId: opts.accountId ?? null,
      product,
      plan,
      qty: 1,
      at: opts.at ?? new Date(),
      actor: "System",
      status: opts.status,
    }),
  );
}

/** A paid order with one NEW item, fulfilled like the payment webhook does; returns the order id and the issued key. */
export async function paidOrderWithLicense(plan: Plan, accountId: string | null): Promise<{ orderId: string; licenseId: string; key: string }> {
  const orderId = uniq("AX-ACT");
  const paidAt = new Date();
  await db.order.create({
    data: {
      id: orderId,
      accountId,
      email: "priya@example.test",
      billing: { name: "Priya Sharma", state: "Maharashtra" },
      status: "PAID",
      subtotalPaise: plan.pricePaise,
      taxablePaise: plan.pricePaise,
      totalPaise: plan.pricePaise,
      placeOfSupply: "Maharashtra",
      paidAt,
      items: {
        create: [{ planId: plan.id, kind: "NEW", quantity: 1, unitPricePaise: plan.pricePaise, taxablePaise: plan.pricePaise, taxPaise: 0 }],
      },
    },
  });
  const [result] = await db.$transaction((tx) => fulfilOrderItems(tx, { id: orderId, accountId, paidAt }));
  if (!result?.key) throw new Error("Fulfilment issued no key");
  return { orderId, licenseId: result.licenseId, key: result.key };
}

/** A parsed activation body (the same parsing the route does). */
export function activationInput(key: string, fingerprint: string, extra: Partial<Record<keyof ActivateRequest, string>> = {}): ActivateRequest {
  return activateRequestSchema.parse({
    licenseKey: key,
    deviceFingerprint: fingerprint,
    deviceName: "Billing counter PC",
    os: "Windows 11 Pro",
    appVersion: "4.2.1",
    ...extra,
  });
}

/** Settles a promise into its rejection (or null when it resolved). */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}
