/**
 * SQL building blocks for the admin license lists (Licenses and Renewals). The filters and sorts the prototype offers
 * (derived status, "at the device limit", devices used/limit, customer name, renewal value) are not expressible as a
 * Prisma `where`/`orderBy`, so a page of ids is selected with raw SQL and the rows are then loaded with Prisma.
 * Every value is a bound parameter; enum and column names are literals in this file only.
 */
import "server-only";
import { DAY_MS } from "@/lib/dates";
import { Prisma, type Db } from "@/lib/db";
import { getLicenseKeySecrets } from "@/lib/env";
import { hashLicenseKey } from "@/lib/licensing/crypto";
import { isLicenseKeyFormat, normalizeLicenseKey } from "@/lib/licensing/keys";
import { EXPIRING_DAYS, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { likeContains } from "./list-state";

/** License l with its account a, issuing order lo (guest licenses: the buyer's email) and plan p. */
export const LICENSE_FROM = Prisma.sql`"License" l
  LEFT JOIN "BusinessAccount" a ON a."id" = l."accountId"
  LEFT JOIN "Order" lo ON lo."id" = l."orderId"
  JOIN "Plan" p ON p."id" = l."planId"`;

/** Active devices of l (DeviceActivation_licenseId_fingerprint_idx). */
export const ACTIVE_DEVICES_SQL = Prisma.sql`(SELECT count(*) FROM "DeviceActivation" d WHERE d."licenseId" = l."id" AND d."deactivatedAt" IS NULL)`;

/** Customer label used for sorting: the business, else the guest order's email. */
export const CUSTOMER_SORT_SQL = Prisma.sql`lower(COALESCE(a."legalName", lo."email", ''))`;

/** Renewal value: plan price, times the device limit for per-unit plans. */
export const RENEWAL_VALUE_SQL = Prisma.sql`(p."pricePaise"::bigint * CASE WHEN p."perUnit" IS NOT NULL THEN GREATEST(l."deviceLimit", 1) ELSE 1 END)`;

/** Raw timestamps are compared as timestamp(3) (UTC, no zone), the column type; see lib/auth/rate-limit.ts. */

/** SQL form of deriveLicenseStatus() for one status (same rules as lib/licensing/account.ts derivedStatusWhere). */
export function derivedStatusSql(status: DerivedLicenseStatus, now: Date): Prisma.Sql {
  const soon = new Date(now.getTime() + EXPIRING_DAYS * DAY_MS);
  switch (status) {
    case "revoked":
      return Prisma.sql`l."status" = 'REVOKED'`;
    case "suspended":
      return Prisma.sql`l."status" = 'SUSPENDED'`;
    case "expired":
      return Prisma.sql`(l."status" IN ('ACTIVE', 'TRIAL') AND l."expiresAt" <= ${now}::timestamp(3))`;
    case "trial":
      return Prisma.sql`(l."status" = 'TRIAL' AND (l."expiresAt" IS NULL OR l."expiresAt" > ${now}::timestamp(3)))`;
    case "expiring":
      return Prisma.sql`(l."status" = 'ACTIVE' AND l."expiresAt" > ${now}::timestamp(3) AND l."expiresAt" < ${soon}::timestamp(3))`;
    case "active":
      return Prisma.sql`(l."status" = 'ACTIVE' AND (l."expiresAt" IS NULL OR l."expiresAt" >= ${soon}::timestamp(3)))`;
  }
}

/** The derived status as text, for sorting by the badge (the prototype sorts by the status key). */
export function derivedStatusCaseSql(now: Date): Prisma.Sql {
  const soon = new Date(now.getTime() + EXPIRING_DAYS * DAY_MS);
  return Prisma.sql`(CASE
    WHEN l."status" = 'REVOKED' THEN 'revoked'
    WHEN l."status" = 'SUSPENDED' THEN 'suspended'
    WHEN l."expiresAt" IS NOT NULL AND l."expiresAt" <= ${now}::timestamp(3) THEN 'expired'
    WHEN l."status" = 'TRIAL' THEN 'trial'
    WHEN l."expiresAt" IS NOT NULL AND l."expiresAt" < ${soon}::timestamp(3) THEN 'expiring'
    ELSE 'active' END)`;
}

/** Keyed hash of a pasted full key (never logged), or null when the text is not a key. */
function pastedKeyHash(q: string): string | null {
  const normalized = normalizeLicenseKey(q);
  if (!isLicenseKeyFormat(normalized)) return null;
  return hashLicenseKey(normalized, getLicenseKeySecrets().pepper);
}

/**
 * Prototype search "license ID, last 4 of key, email or device": license id, business name, a member's name or email,
 * the guest order's email, a device name, the key's last four characters, or a whole pasted key (by its hash only).
 * One set of license ids per searched table, each found through that table's own index (the trigram indexes of
 * docs/performance.md), joined by UNION: one OR over the joined columns had to join and test every license (2.3 s at
 * 3 lakh licenses against 13 ms).
 */
export function licenseSearchSql(q: string): Prisma.Sql | null {
  const term = q.trim();
  if (term === "") return null;
  const keyHash = pastedKeyHash(term);
  if (keyHash) return Prisma.sql`l."keyHash" = ${keyHash}`;
  const like = likeContains(term);
  const sets: Prisma.Sql[] = [
    Prisma.sql`SELECT s."id" FROM "License" s WHERE s."id" ILIKE ${like} ESCAPE '!'`,
    Prisma.sql`SELECT s."id" FROM "License" s JOIN "BusinessAccount" ba ON ba."id" = s."accountId"
      WHERE ba."legalName" ILIKE ${like} ESCAPE '!'`,
    Prisma.sql`SELECT s."id" FROM "License" s JOIN "Order" o ON o."id" = s."orderId" WHERE o."email" ILIKE ${like} ESCAPE '!'`,
    Prisma.sql`SELECT s."id" FROM "License" s JOIN "AccountMember" m ON m."accountId" = s."accountId" JOIN "User" u ON u."id" = m."userId"
      WHERE u."email" ILIKE ${like} ESCAPE '!' OR u."name" ILIKE ${like} ESCAPE '!'`,
    Prisma.sql`SELECT d."licenseId" FROM "DeviceActivation" d WHERE d."name" ILIKE ${like} ESCAPE '!'`,
  ];
  if (/^[A-Za-z0-9]{4}$/.test(term)) sets.push(Prisma.sql`SELECT s."id" FROM "License" s WHERE s."keyLast4" = ${term.toUpperCase()}`);
  return Prisma.sql`l."id" IN (${Prisma.join(sets, " UNION ")})`;
}

export function andAll(conditions: readonly Prisma.Sql[]): Prisma.Sql {
  return conditions.length > 0 ? Prisma.join(conditions, " AND ") : Prisma.sql`TRUE`;
}

export function sqlDirection(desc: boolean): Prisma.Sql {
  return Prisma.raw(desc ? "DESC" : "ASC");
}

/** One page of license ids in order, plus the total that matches `where`. */
export async function pageLicenseIds(
  db: Db,
  opts: { where: Prisma.Sql; orderBy: Prisma.Sql; skip: number; take: number },
): Promise<{ ids: string[]; total: number }> {
  const [rows, counted] = await Promise.all([
    db.$queryRaw<{ id: string }[]>`SELECT l."id" FROM ${LICENSE_FROM} WHERE ${opts.where}
      ORDER BY ${opts.orderBy} LIMIT ${opts.take} OFFSET ${opts.skip}`,
    db.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS "total" FROM ${LICENSE_FROM} WHERE ${opts.where}`,
  ]);
  return { ids: rows.map((r) => r.id), total: counted[0]?.total ?? 0 };
}

/** Rows loaded by id (Prisma), put back in the order of `ids`. */
export function inIdOrder<T extends { id: string }>(ids: readonly string[], rows: readonly T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
}
