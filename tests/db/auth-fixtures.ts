/**
 * Fixtures for the auth DB tests (tests/db/auth-*.test.ts). Not a test file itself.
 * Every helper creates uniquely named rows, because DB test files share one schema per run.
 */
import { randomBytes, randomInt } from "node:crypto";
import type { Plan, Product, User } from "@/generated/prisma/client";
import { hashPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";

export const PASSWORD = "Correct1horse";
export const OTHER_PASSWORD = "Another2horse";

export type SentMail = { to: string; templateId: string; vars: Record<string, string> };

export const uniqueEmail = (name: string) => `${name}.${randomBytes(4).toString("hex")}@example.test`;
export const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const tag = () => randomBytes(3).toString("hex");

let cachedHash: Promise<string> | null = null;
/** One argon2 hash of PASSWORD shared by all fixtures (hashing is deliberately slow). */
export function passwordHashOf(password: string = PASSWORD): Promise<string> {
  if (password !== PASSWORD) return hashPassword(password);
  cachedHash ??= hashPassword(PASSWORD);
  return cachedHash;
}

export type UserOptions = {
  email?: string;
  name?: string;
  kind?: "CUSTOMER" | "STAFF";
  verified?: boolean;
  twoStep?: boolean;
  staffStatus?: "ACTIVE" | "INVITED" | "DEACTIVATED";
  password?: string | null;
};

/** A user; customers also get a business account they OWN. */
export async function makeUser(opts: UserOptions = {}): Promise<{ user: User; accountId: string | null }> {
  const kind = opts.kind ?? "CUSTOMER";
  const user = await db.user.create({
    data: {
      email: opts.email ?? uniqueEmail(kind === "STAFF" ? "staff" : "customer"),
      name: opts.name ?? (kind === "STAFF" ? "Sneha Patil" : "Priya Sharma"),
      kind,
      passwordHash: opts.password === null ? null : await passwordHashOf(opts.password ?? PASSWORD),
      emailVerifiedAt: opts.verified === false ? null : new Date("2026-01-01T00:00:00.000Z"),
      twoStepEnabled: opts.twoStep ?? false,
      staffRole: kind === "STAFF" ? "SUPPORT" : null,
      staffStatus: kind === "STAFF" ? (opts.staffStatus ?? "ACTIVE") : null,
    },
  });
  if (kind === "STAFF") return { user, accountId: null };
  const account = await db.businessAccount.create({ data: { legalName: `${user.name} Medicals` } });
  await db.accountMember.create({ data: { accountId: account.id, userId: user.id, role: "OWNER" } });
  return { user, accountId: account.id };
}

let catalog: Promise<{ product: Product; plan: Plan }> | null = null;

/** One product + annual plan for license rows (Product.code is unique across the shared schema). */
export function testCatalog(): Promise<{ product: Product; plan: Plan }> {
  catalog ??= (async () => {
    const t = tag();
    const category = await db.category.create({ data: { id: `auth-cat-${t}`, name: "Auth test", tone: "sage", icon: "key" } });
    let product: Product | null = null;
    for (let i = 0; !product && i < 20; i++) {
      const code = Array.from({ length: 3 }, () => String.fromCharCode(65 + randomInt(26))).join("");
      if (await db.product.findUnique({ where: { code } })) continue;
      product = await db.product.create({
        data: {
          id: `auth-product-${t}`,
          code,
          name: "Auth Test Billing",
          shortName: "Auth",
          tagline: "Test",
          summary: "Test",
          icon: "receipt_long",
          categoryId: category.id,
          platforms: ["windows"],
          status: "PUBLISHED",
          content: {},
          relatedIds: [],
        },
      });
    }
    if (!product) throw new Error("Could not pick a free product code.");
    const plan = await db.plan.create({
      data: { id: `auth-annual-${t}`, productId: product.id, type: "ANNUAL", name: "Annual", includes: [], pricePaise: 500_000, interval: "YEAR", deviceLimit: 1 },
    });
    return { product, plan };
  })();
  return catalog;
}

/** A paid order for `email` (guest unless accountId is given), optionally with one license row. */
export async function makeOrder(email: string, opts: { accountId?: string | null; withLicense?: boolean } = {}) {
  const id = `AX-T${randomBytes(4).toString("hex").toUpperCase()}`;
  const accountId = opts.accountId ?? null;
  const order = await db.order.create({
    data: {
      id,
      email,
      accountId,
      billing: { name: "Priya Sharma", state: "Maharashtra" },
      status: "PAID",
      subtotalPaise: 500_000,
      taxablePaise: 500_000,
      cgstPaise: 45_000,
      sgstPaise: 45_000,
      totalPaise: 590_000,
      placeOfSupply: "Maharashtra",
      paidAt: new Date("2026-09-01T06:30:00.000Z"),
    },
  });
  if (!opts.withLicense) return { order, licenseId: null };
  const { product, plan } = await testCatalog();
  const license = await db.license.create({
    data: {
      id: `LIC-T${randomBytes(4).toString("hex").toUpperCase()}`,
      accountId,
      productId: product.id,
      planId: plan.id,
      orderId: order.id,
      keyHash: randomBytes(32).toString("hex"),
      keyCiphertext: "v1.test.test.test",
      keyLast4: "K8NM",
      updatesUntil: new Date("2027-09-01T06:30:00.000Z"),
      expiresAt: new Date("2027-09-01T06:30:00.000Z"),
      deviceLimit: 1,
      resetsYear: 2026,
    },
  });
  return { order, licenseId: license.id };
}

/** Pulls the newest captured mail of a template for an address. */
export function lastMail(sent: SentMail[], to: string, templateId: string): SentMail {
  const found = [...sent].reverse().find((m) => m.to === to && m.templateId === templateId);
  if (!found) throw new Error(`No ${templateId} email to ${to}`);
  return found;
}

export function codeIn(mail: SentMail): string {
  const code = mail.vars.code;
  if (!code || !/^[0-9]{6}$/.test(code)) throw new Error("No code in the email");
  return code;
}

/** The "<id>.<secret>" token from a reset email. */
export function resetTokenIn(mail: SentMail): string {
  const url = mail.vars.reset_url;
  if (!url) throw new Error("No reset link in the email");
  const token = new URL(url).searchParams.get("token");
  if (!token) throw new Error("No token in the reset link");
  return token;
}
