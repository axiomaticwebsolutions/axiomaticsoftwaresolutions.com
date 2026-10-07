/**
 * Admin renewal reads (prototype `renewRows`): non-revoked, non-trial licenses with an end date in the next 60 days or
 * the last 30, with the Window filter, search, sorts, the stats row and each row's last reminder. Ids are paged with
 * raw SQL (lib/admin/licenses/sql.ts) and the rows loaded with Prisma.
 */
import "server-only";
import { DAY_MS } from "@/lib/dates";
import { Prisma, type Db } from "@/lib/db";
import { deriveLicenseStatus } from "@/lib/licensing/status";
import { loadLicenseCustomers, loadLicenseRecords } from "@/lib/admin/licenses/queries";
import { renewalValuePaise } from "@/lib/admin/licenses/model";
import {
  andAll,
  CUSTOMER_SORT_SQL,
  LICENSE_FROM,
  licenseSearchSql,
  pageLicenseIds,
  RENEWAL_VALUE_SQL,
  sqlDirection,
} from "@/lib/admin/licenses/sql";
import {
  RENEWAL_AHEAD_DAYS,
  RENEWAL_LAPSED_DAYS,
  RENEWAL_SOON_DAYS,
  renewalDaysLeft,
  renewalReminderPrefix,
  type AdminRenewalRow,
  type AdminRenewalStats,
  type RenewalListQuery,
  type RenewalSort,
} from "./model";

const ts = (d: Date) => Prisma.sql`${d}::timestamp(3)`;

/** The Renewals row set (prototype renewRows). */
export function renewalBaseSql(now: Date): Prisma.Sql {
  const from = new Date(now.getTime() - RENEWAL_LAPSED_DAYS * DAY_MS);
  const to = new Date(now.getTime() + RENEWAL_AHEAD_DAYS * DAY_MS);
  return Prisma.sql`(l."status" IN ('ACTIVE', 'SUSPENDED') AND p."type" <> 'TRIAL'
    AND l."expiresAt" > ${ts(from)} AND l."expiresAt" < ${ts(to)})`;
}

export function renewalListWhere(query: Pick<RenewalListQuery, "q" | "filters">, now: Date): Prisma.Sql {
  const conditions: Prisma.Sql[] = [renewalBaseSql(now)];
  const soon = new Date(now.getTime() + RENEWAL_SOON_DAYS * DAY_MS);
  if (query.filters.window === "30") conditions.push(Prisma.sql`l."expiresAt" > ${ts(now)} AND l."expiresAt" < ${ts(soon)}`);
  if (query.filters.window === "60") conditions.push(Prisma.sql`l."expiresAt" >= ${ts(soon)}`);
  if (query.filters.window === "lapsed") conditions.push(Prisma.sql`l."expiresAt" <= ${ts(now)}`);
  const search = licenseSearchSql(query.q);
  if (search) conditions.push(search);
  return andAll(conditions);
}

export function renewalListOrderBy(sort: { id: RenewalSort; desc: boolean }): Prisma.Sql {
  const dir = sqlDirection(sort.desc);
  const byId = Prisma.sql`length(l."id") ${dir}, l."id" ${dir}`;
  switch (sort.id) {
    case "id":
      return byId;
    case "customer":
      return Prisma.sql`${CUSTOMER_SORT_SQL} ${dir}, ${byId}`;
    case "ends":
    case "days":
      return Prisma.sql`l."expiresAt" ${dir}, ${byId}`;
    case "value":
      return Prisma.sql`${RENEWAL_VALUE_SQL} ${dir}, ${byId}`;
  }
}

/** Newest reminder per license, from the outbox rows' dedupe keys (renewal:<licenseId>:...). */
export async function lastRemindersFor(db: Db, ids: readonly string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (ids.length === 0) return out;
  const rows = await db.outboxEmail.findMany({
    where: { OR: ids.map((id) => ({ dedupeKey: { startsWith: renewalReminderPrefix(id) } })) },
    select: { dedupeKey: true, createdAt: true },
  });
  for (const row of rows) {
    const id = row.dedupeKey?.split(":")[1];
    if (!id) continue;
    const seen = out.get(id);
    if (!seen || seen.getTime() < row.createdAt.getTime()) out.set(id, row.createdAt);
  }
  return out;
}

async function renewalRows(db: Db, ids: readonly string[], now: Date): Promise<AdminRenewalRow[]> {
  const records = await loadLicenseRecords(db, ids);
  const [customerOf, reminders] = await Promise.all([loadLicenseCustomers(db, records), lastRemindersFor(db, ids)]);
  return records
    .filter((r) => r.expiresAt !== null)
    .map((r) => {
      const expiresAt = r.expiresAt as Date;
      const customer = customerOf(r);
      return {
        id: r.id,
        productId: r.productId,
        productName: r.product.name,
        productShortName: r.product.shortName,
        planName: r.plan.name,
        planType: r.plan.type,
        customerName: customer.customerName,
        customerEmail: customer.customerEmail,
        accountId: r.accountId,
        status: deriveLicenseStatus(r, now),
        expiresAt: expiresAt.toISOString(),
        daysLeft: renewalDaysLeft(expiresAt, now),
        renewalValuePaise: renewalValuePaise(r.plan, r.deviceLimit),
        lastReminderAt: reminders.get(r.id)?.toISOString() ?? null,
      };
    });
}

export type AdminRenewalList = { items: AdminRenewalRow[]; total: number };

export async function listAdminRenewals(db: Db, query: RenewalListQuery, now: Date): Promise<AdminRenewalList> {
  const { ids, total } = await pageLicenseIds(db, {
    where: renewalListWhere(query, now),
    orderBy: renewalListOrderBy(query.sort),
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
  });
  return { items: await renewalRows(db, ids, now), total };
}

export async function exportAdminRenewals(db: Db, query: RenewalListQuery, now: Date, limit: number): Promise<AdminRenewalRow[]> {
  const { ids } = await pageLicenseIds(db, { where: renewalListWhere(query, now), orderBy: renewalListOrderBy(query.sort), skip: 0, take: limit });
  return renewalRows(db, ids, now);
}

/** Stats row: DUE <= 30 DAYS, DUE 31-60 DAYS, LAPSED (30 DAYS), RENEWAL VALUE (excl. GST) over the whole row set. */
export async function adminRenewalStats(db: Db, now: Date): Promise<AdminRenewalStats> {
  const soon = new Date(now.getTime() + RENEWAL_SOON_DAYS * DAY_MS);
  const rows = await db.$queryRaw<{ dueSoon: number; dueLater: number; lapsed: number; value: bigint | number | string | null }[]>`
    SELECT
      count(*) FILTER (WHERE l."expiresAt" > ${ts(now)} AND l."expiresAt" < ${ts(soon)})::int AS "dueSoon",
      count(*) FILTER (WHERE l."expiresAt" >= ${ts(soon)})::int AS "dueLater",
      count(*) FILTER (WHERE l."expiresAt" <= ${ts(now)})::int AS "lapsed",
      COALESCE(sum(${RENEWAL_VALUE_SQL}), 0)::bigint AS "value"
    FROM ${LICENSE_FROM}
    WHERE ${renewalBaseSql(now)}`;
  const row = rows[0];
  return { dueSoon: row?.dueSoon ?? 0, dueLater: row?.dueLater ?? 0, lapsed: row?.lapsed ?? 0, valuePaise: Number(row?.value ?? 0) };
}
