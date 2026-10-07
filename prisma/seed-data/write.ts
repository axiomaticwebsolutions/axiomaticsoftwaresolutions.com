/**
 * Database writes for the seed plan (prisma/seed-data/plan.ts). Every row is upserted by its deterministic id
 * inside short interactive transactions, in foreign-key order, so a second run updates the same rows.
 * Separated from prisma/seed.ts (env, passwords, summary) so the write path is unit-tested with a fake client.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Tx } from "@/lib/db";
import { sealLicenseKey, type LicenseKeySecrets } from "@/lib/licensing/crypto";
import { generateLicenseKey } from "@/lib/licensing/keys";
import type { LicenseGroup, OrderGroup, SeedInviteToken, SeedPlanData } from "./plan";

export const TX_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const;
export const ORDERS_PER_TRANSACTION = 12;

/** A seed precondition failed; the message is safe to print (it never contains secret values). */
export class SeedError extends Error {
  override name = "SeedError";
}

export type SeedWriteSecrets = {
  /** argon2id hash per user id; null for users who cannot sign in. */
  passwordHashes: ReadonlyMap<string, string | null>;
  licenseKeys: LicenseKeySecrets;
  /** Key generator for new random-key licenses (crypto.randomInt by default; injectable for tests). */
  generateKey?: (productCode: string) => string;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function each<T>(items: readonly T[], write: (item: T) => Promise<unknown>): Promise<void> {
  // Interactive transactions run on one connection, so writes are sequential by design.
  for (const item of items) await write(item);
}

/** Fails early, with a clear message, when a non-seed user already holds one of the seeded email addresses. */
export async function assertNoEmailConflicts(db: PrismaClient, plan: SeedPlanData): Promise<void> {
  const planned = new Map(plan.users.map((u) => [u.row.email, u.row.id]));
  const existing = await db.user.findMany({ where: { email: { in: [...planned.keys()] } }, select: { id: true, email: true } });
  const conflicts = existing.filter((u) => planned.get(u.email) !== u.id).map((u) => u.email);
  if (conflicts.length > 0) {
    throw new SeedError(
      `These emails already belong to users the seed did not create: ${conflicts.join(", ")}. ` +
        "Reset the dev database (`pnpm db:reset`) or change SEED_OWNER_EMAIL.",
    );
  }
}

async function writeCatalog(tx: Tx, plan: SeedPlanData): Promise<void> {
  await each(plan.settings, (s) => tx.siteSetting.upsert({ where: { key: s.key }, create: s, update: { value: s.value } }));
  await each(plan.categories, (r) => tx.category.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.products, (r) => tx.product.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.plans, (r) => tx.plan.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.releases, (r) => tx.release.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.releaseFiles, (r) => tx.releaseFile.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.faqs, (r) => tx.faq.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.coupons, (r) => tx.coupon.upsert({ where: { code: r.code }, create: r, update: r }));
  await each(plan.templates, (r) => tx.notificationTemplate.upsert({ where: { id: r.id }, create: r, update: r }));
}

async function writePeople(tx: Tx, plan: SeedPlanData, hashes: ReadonlyMap<string, string | null>): Promise<void> {
  await each(plan.users, (u) => {
    const data = { ...u.row, passwordHash: hashes.get(u.row.id) ?? null };
    return tx.user.upsert({ where: { id: u.row.id }, create: data, update: data });
  });
  await each(plan.accounts, (r) => tx.businessAccount.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.members, (r) => tx.accountMember.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.inviteTokens, (r) => writeInviteToken(tx, r, plan.now));
  await each(plan.locations, (r) => tx.location.upsert({ where: { id: r.id }, create: r, update: r }));
}

/** SHA-256 (hex) of a fresh 256-bit secret that is dropped at once: the stored link can never be opened. */
function unusableTokenHash(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

/**
 * A seeded invitation link (re)opened on every run with a new unusable hash. Other open links of the same person for
 * the same account (e.g. a Resend clicked in development) stop working, as when an owner sends the invitation again.
 */
async function writeInviteToken(tx: Tx, row: SeedInviteToken, now: Date): Promise<void> {
  await tx.authToken.updateMany({
    where: { type: row.type, userId: row.userId, usedAt: null, id: { not: row.id }, meta: { path: ["accountId"], equals: row.meta.accountId } },
    data: { usedAt: now },
  });
  const data = { ...row, codeHash: unusableTokenHash() };
  await tx.authToken.upsert({ where: { id: row.id }, create: data, update: data });
}

/**
 * Sample keys from the prototype are re-sealed on every run (same hash; survives a changed encryption key).
 * Generated keys are drawn with crypto.randomInt only when the license is first inserted, and kept afterwards.
 */
async function writeLicense(tx: Tx, group: LicenseGroup, secrets: SeedWriteSecrets): Promise<void> {
  const { license } = group;
  const generate = secrets.generateKey ?? ((code: string) => generateLicenseKey(code));
  const key = license.key.kind === "fixed" ? license.key.key : generate(license.key.productCode);
  const sealed = sealLicenseKey(key, secrets.licenseKeys);
  await tx.license.upsert({
    where: { id: license.row.id },
    create: { ...license.row, ...sealed },
    update: license.key.kind === "fixed" ? { ...license.row, ...sealed } : license.row,
  });
  await each(group.devices, (r) => tx.deviceActivation.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(group.events, (r) => tx.licenseEvent.upsert({ where: { id: r.id }, create: r, update: r }));
}

async function writeOrderGroup(tx: Tx, group: OrderGroup, secrets: SeedWriteSecrets): Promise<void> {
  const { bundle } = group;
  await tx.order.upsert({ where: { id: bundle.order.id }, create: bundle.order, update: bundle.order });
  await each(bundle.items, (r) => tx.orderItem.upsert({ where: { id: r.id }, create: r, update: r }));
  await tx.payment.upsert({ where: { id: bundle.payment.id }, create: bundle.payment, update: bundle.payment });
  if (bundle.redemption) {
    const r = bundle.redemption;
    await tx.couponRedemption.upsert({ where: { id: r.id }, create: r, update: r });
  }
  if (group.invoice) {
    const r = group.invoice;
    await tx.invoice.upsert({ where: { id: r.id }, create: r, update: r });
  }
  if (group.refund) {
    const r = group.refund;
    await tx.refund.upsert({ where: { id: r.id }, create: r, update: r });
  }
  await each(group.licenses, (l) => writeLicense(tx, l, secrets));
}

/**
 * Invoice and credit-note numbers are unique. If a sample order moved to another financial year since the last run
 * (dates are relative to the run), its old number may now belong to another sample row, so seeded rows whose number
 * changes are parked on a temporary value before the upserts assign the new numbers.
 */
async function releaseChangedNumbers(tx: Tx, plan: SeedPlanData): Promise<void> {
  const invoices = new Map(plan.orderGroups.flatMap((g) => (g.invoice ? [[g.invoice.id, g.invoice.number] as const] : [])));
  const storedInvoices = await tx.invoice.findMany({ where: { id: { in: [...invoices.keys()] } }, select: { id: true, number: true } });
  await each(
    storedInvoices.filter((r) => invoices.get(r.id) !== r.number),
    (r) => tx.invoice.update({ where: { id: r.id }, data: { number: `SEEDTMP-${r.id}` } }),
  );
  const refunds = new Map(plan.orderGroups.flatMap((g) => (g.refund ? [[g.refund.id, g.refund.creditNoteNo ?? null] as const] : [])));
  const storedRefunds = await tx.refund.findMany({ where: { id: { in: [...refunds.keys()] } }, select: { id: true, creditNoteNo: true } });
  await each(
    storedRefunds.filter((r) => refunds.get(r.id) !== r.creditNoteNo),
    (r) => tx.refund.update({ where: { id: r.id }, data: { creditNoteNo: `SEEDTMP-${r.id}` } }),
  );
}

async function writeSupport(tx: Tx, plan: SeedPlanData): Promise<void> {
  await each(plan.tickets, (r) => tx.supportTicket.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.ticketMessages, (r) => tx.ticketMessage.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.notifications, (r) => tx.notification.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.activities, (r) => tx.accountActivity.upsert({ where: { id: r.id }, create: r, update: r }));
}

async function writeOperations(tx: Tx, plan: SeedPlanData): Promise<void> {
  await each(plan.webhookEvents, (r) =>
    tx.webhookEvent.upsert({ where: { provider_id: { provider: r.provider, id: r.id } }, create: r, update: r }),
  );
  await each(plan.webhookDeliveries, (r) => tx.webhookDelivery.upsert({ where: { id: r.id }, create: r, update: r }));
  await each(plan.auditLogs, (r) => tx.auditLog.upsert({ where: { id: r.id }, create: r, update: r }));
}

/** Counters only move forward: numbers already handed out by the running app are never reused. */
async function writeCounters(tx: Tx, plan: SeedPlanData): Promise<void> {
  await each(plan.counters, async (c) => {
    const stored = await tx.counter.findUnique({ where: { key: c.key } });
    const next = Math.max(stored?.next ?? 0, c.next);
    await tx.counter.upsert({ where: { key: c.key }, create: { key: c.key, next }, update: { next } });
  });
}

export async function countRows(db: PrismaClient): Promise<[string, number][]> {
  const counts: [string, Promise<number>][] = [
    ["users", db.user.count()],
    ["business accounts", db.businessAccount.count()],
    ["account members", db.accountMember.count()],
    ["locations", db.location.count()],
    ["categories", db.category.count()],
    ["products", db.product.count()],
    ["plans", db.plan.count()],
    ["releases", db.release.count()],
    ["release files", db.releaseFile.count()],
    ["faqs", db.faq.count()],
    ["coupons", db.coupon.count()],
    ["coupon redemptions", db.couponRedemption.count()],
    ["notification templates", db.notificationTemplate.count()],
    ["site settings", db.siteSetting.count()],
    ["orders", db.order.count()],
    ["order items", db.orderItem.count()],
    ["payments", db.payment.count()],
    ["invoices", db.invoice.count()],
    ["refunds", db.refund.count()],
    ["licenses", db.license.count()],
    ["device activations", db.deviceActivation.count()],
    ["license events", db.licenseEvent.count()],
    ["support tickets", db.supportTicket.count()],
    ["ticket messages", db.ticketMessage.count()],
    ["notifications", db.notification.count()],
    ["account activity", db.accountActivity.count()],
    ["webhook events", db.webhookEvent.count()],
    ["webhook deliveries", db.webhookDelivery.count()],
    ["audit log", db.auditLog.count()],
    ["counters", db.counter.count()],
  ];
  const values = await Promise.all(counts.map(([, p]) => p));
  return counts.map(([label], i) => [label, values[i] ?? 0]);
}

/** Writes the whole plan. Call assertNoEmailConflicts first so a clash fails before anything is written. */
export async function writeSeedPlan(db: PrismaClient, plan: SeedPlanData, secrets: SeedWriteSecrets): Promise<void> {
  await db.$transaction((tx) => writeCatalog(tx, plan), TX_OPTIONS);
  await db.$transaction((tx) => writePeople(tx, plan, secrets.passwordHashes), TX_OPTIONS);
  await db.$transaction((tx) => releaseChangedNumbers(tx, plan), TX_OPTIONS);
  for (const groups of chunk(plan.orderGroups, ORDERS_PER_TRANSACTION)) {
    await db.$transaction((tx) => each(groups, (g) => writeOrderGroup(tx, g, secrets)), TX_OPTIONS);
  }
  await db.$transaction((tx) => each(plan.standaloneLicenses, (l) => writeLicense(tx, l, secrets)), TX_OPTIONS);
  await db.$transaction((tx) => writeSupport(tx, plan), TX_OPTIONS);
  await db.$transaction((tx) => writeOperations(tx, plan), TX_OPTIONS);
  await db.$transaction((tx) => writeCounters(tx, plan), TX_OPTIONS);
}
