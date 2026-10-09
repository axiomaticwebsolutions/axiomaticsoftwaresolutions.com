/**
 * Fixtures for the admin catalog DB tests (tests/db/admin-catalog-*.test.ts). Not a test file. Ids are unique per
 * call because DB test files share one schema per run.
 */
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { freshProductCode } from "../support/product-codes";

export const tag = () => randomBytes(4).toString("hex");

/** Valid Product.content (passes productContentSchema; icons exist in the registry). */
export const VALID_CONTENT = {
  features: [{ icon: "receipt_long", title: "GST billing", body: "Bills with HSN codes and tax splits." }],
  benefits: [{ title: "Faster counters", body: "Bill a customer in seconds." }],
  requirements: [{ label: "OS", value: "Windows 10 or later" }],
};

export async function makeCategory(overrides: { id?: string; name?: string } = {}) {
  const t = tag();
  return db.category.create({
    data: { id: overrides.id ?? `cat-${t}`, name: overrides.name ?? `Category ${t}`, tone: "sage", icon: "storefront", sortOrder: 5 },
  });
}

/** A product (DRAFT unless told otherwise) in a new category, with an unused 3-letter code. */
export async function makeProduct(
  opts: { status?: "DRAFT" | "PUBLISHED" | "HIDDEN" | "COMING_SOON"; platforms?: string[]; content?: object; categoryId?: string; name?: string } = {},
) {
  const t = tag();
  const categoryId = opts.categoryId ?? (await makeCategory()).id;
  return db.product.create({
    data: {
      id: `prod-${t}`,
      code: await freshProductCode(),
      name: opts.name ?? `Catalog Test Billing ${t}`,
      shortName: `Catalog ${t}`,
      tagline: "Tagline",
      summary: "Summary",
      icon: "storefront",
      categoryId,
      platforms: opts.platforms ?? ["windows", "macos"],
      status: opts.status ?? "DRAFT",
      content: opts.content ?? { features: [], benefits: [], requirements: [] },
      relatedIds: [],
      rank: 50,
    },
  });
}

export async function makePlan(productId: string, data: Record<string, unknown> = {}) {
  const t = tag();
  return db.plan.create({
    data: {
      id: `plan-${t}`,
      productId,
      type: "ANNUAL",
      name: "Annual license",
      includes: [],
      pricePaise: 600_000,
      interval: "YEAR",
      deviceLimit: 1,
      ...data,
    } as never,
  });
}

export async function makeRelease(
  productId: string,
  opts: { version?: string; status?: "DRAFT" | "PUBLISHED" | "WITHDRAWN"; releasedAt?: Date | null; channel?: string; withFile?: boolean } = {},
) {
  const version = opts.version ?? `9.${Math.floor(Math.random() * 1000)}.${Math.floor(Math.random() * 1000)}`;
  const status = opts.status ?? "DRAFT";
  return db.release.create({
    data: {
      productId,
      version,
      channel: opts.channel ?? "stable",
      status,
      releasedAt: opts.releasedAt === undefined ? (status === "DRAFT" ? null : new Date()) : opts.releasedAt,
      notes: ["First note"],
      files: opts.withFile
        ? {
            create: {
              platform: "windows",
              fileName: `setup-${version}.exe`,
              storageKey: `releases/${productId}/${version}/${tag()}/setup.exe`,
              sizeBytes: BigInt(1024),
              sha256: "0".repeat(64),
            },
          }
        : undefined,
    },
  });
}

/** Audit rows for a target id, oldest first. */
export async function auditRows(targetId: string) {
  return db.auditLog.findMany({ where: { targetId }, orderBy: { createdAt: "asc" } });
}

const DAY = 86_400_000;

/** A license row with a fake key (these tests never use the key). */
export async function makeLicenseRow(
  productId: string,
  planId: string,
  accountId: string | null,
  data: { status?: "ACTIVE" | "TRIAL" | "SUSPENDED" | "REVOKED"; expiresAt?: Date | null; updatesUntil?: Date } = {},
) {
  const t = tag();
  return db.license.create({
    data: {
      id: `LIC-CT${t.toUpperCase()}`,
      productId,
      planId,
      accountId,
      keyHash: `cat-hash-${t}-${tag()}`,
      keyCiphertext: "v1.x.y.z",
      keyLast4: "AAAA",
      status: data.status ?? "ACTIVE",
      expiresAt: data.expiresAt === undefined ? new Date(Date.now() + 200 * DAY) : data.expiresAt,
      updatesUntil: data.updatesUntil ?? new Date(Date.now() + 200 * DAY),
      deviceLimit: 1,
      resetsYear: 2026,
    },
  });
}

/** A business account with members: { role, verified, updates (email pref), status }. */
export async function makeAccount(
  members: { role?: "OWNER" | "BILLING" | "TECHNICAL" | "VIEWER"; verified?: boolean; updates?: boolean; status?: "ACTIVE" | "INVITED" }[],
) {
  const account = await db.businessAccount.create({ data: { legalName: `Catalog Traders ${tag()}` } });
  const users = [];
  for (const m of members) {
    const user = await db.user.create({
      data: {
        email: `catalog.${tag()}@example.test`,
        name: "Priya Sharma",
        kind: "CUSTOMER",
        emailVerifiedAt: m.verified === false ? null : new Date("2026-01-01T00:00:00.000Z"),
        notificationPrefs: m.updates === false ? { renewals: true, updates: false, tickets: true, offers: false } : undefined,
      },
    });
    await db.accountMember.create({ data: { accountId: account.id, userId: user.id, role: m.role ?? "OWNER", status: m.status ?? "ACTIVE" } });
    users.push(user);
  }
  return { account, users };
}
