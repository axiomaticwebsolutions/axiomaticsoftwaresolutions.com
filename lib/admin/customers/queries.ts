/**
 * Admin customer reads: the business-account list with its aggregates (lifetime value, paid orders, last order,
 * active licenses), the drawer detail and the State filter options. The aggregates and sorts are not expressible in a
 * Prisma `where`/`orderBy`, so a page of account rows is selected with raw SQL (bound parameters only) and the rest is
 * loaded with Prisma.
 *
 * Scale note: sorting by lifetime value, orders or last order needs that aggregate for every matching account. A
 * first query computes only that aggregate to pick the page (selectCustomerPage), then the page loads its full rows:
 * at 50,000 accounts and 2 lakh orders (docs/performance.md) about 0.2 s, against 1.1-1.4 s when every account also
 * loaded its owner and licenses. It still grows with the accounts: past a few lakh, keep denormalised values per account.
 */
import "server-only";
import { Prisma, type Db } from "@/lib/db";
import { deriveLicenseStatus } from "@/lib/licensing/status";
import { likeContains } from "@/lib/admin/licenses/list-state";
import { andAll, sqlDirection } from "@/lib/admin/licenses/sql";
import type { AdminCustomerDetail, AdminCustomerMember, AdminCustomerRow, CustomerListQuery, CustomerSort } from "./model";

export const CUSTOMER_DETAIL_LICENSES = 50;
export const CUSTOMER_DETAIL_ORDERS = 8;
export const CUSTOMER_DETAIL_TICKETS = 10;

/** Orders that were paid (refunded ones included: they still count as orders). */
const PAID_STATUSES_SQL = Prisma.sql`('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')`;

/** Paid orders, lifetime value and last paid order over an account's orders `x` (a lateral subquery). */
const ORDER_AGGREGATE_COLUMNS = Prisma.sql`
    count(*) FILTER (WHERE x."status" IN ${PAID_STATUSES_SQL})::int AS "orders",
    COALESCE(sum(CASE
      WHEN x."status" = 'PAID' THEN x."totalPaise"
      WHEN x."status" = 'PARTIALLY_REFUNDED' THEN GREATEST(0, x."totalPaise" - COALESCE((
        SELECT sum(r."amountPaise") FROM "Payment" p JOIN "Refund" r ON r."paymentId" = p."id"
        WHERE p."orderId" = x."id" AND r."status" = 'PROCESSED'), 0))
      ELSE 0 END), 0)::bigint AS "ltv",
    max(x."paidAt") FILTER (WHERE x."status" IN ${PAID_STATUSES_SQL}) AS "lastOrderAt"`;

/** The account's first active Owner (o) and its order (s) and license (lic) aggregates. */
function fromSql(now: Date): Prisma.Sql {
  return Prisma.sql`"BusinessAccount" a
    LEFT JOIN LATERAL (
      SELECT u."id", u."name", u."email", u."emailVerifiedAt"
      FROM "AccountMember" m JOIN "User" u ON u."id" = m."userId"
      WHERE m."accountId" = a."id" AND m."role" = 'OWNER' AND m."status" = 'ACTIVE'
      ORDER BY m."createdAt" ASC, m."id" ASC
      LIMIT 1
    ) o ON TRUE
    LEFT JOIN LATERAL (
      SELECT ${ORDER_AGGREGATE_COLUMNS}
      FROM "Order" x WHERE x."accountId" = a."id"
    ) s ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS "active" FROM "License" l
      WHERE l."accountId" = a."id" AND l."status" IN ('ACTIVE', 'TRIAL')
        AND (l."expiresAt" IS NULL OR l."expiresAt" > ${now}::timestamp(3))
    ) lic ON TRUE`;
}

const SELECT_COLUMNS = Prisma.sql`a."id", a."legalName", a."gstin", a."state",
  o."id" AS "ownerId", o."name" AS "ownerName", o."email" AS "ownerEmail", o."emailVerifiedAt" AS "ownerVerifiedAt",
  s."orders", s."ltv", s."lastOrderAt", lic."active"`;

/** Search: business name, GSTIN, account id, or a member's name or email. */
function searchSql(q: string): Prisma.Sql | null {
  const term = q.trim();
  if (term === "") return null;
  const like = likeContains(term);
  return Prisma.sql`(a."legalName" ILIKE ${like} ESCAPE '!' OR a."gstin" ILIKE ${like} ESCAPE '!' OR a."id" = ${term}
    OR EXISTS (SELECT 1 FROM "AccountMember" m JOIN "User" u ON u."id" = m."userId"
      WHERE m."accountId" = a."id" AND (u."email" ILIKE ${like} ESCAPE '!' OR u."name" ILIKE ${like} ESCAPE '!')))`;
}

export function customerListWhere(query: Pick<CustomerListQuery, "q" | "filters">): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (query.filters.gst === "yes") conditions.push(Prisma.sql`(a."gstin" IS NOT NULL AND a."gstin" <> '')`);
  if (query.filters.gst === "no") conditions.push(Prisma.sql`(a."gstin" IS NULL OR a."gstin" = '')`);
  if (query.filters.state) conditions.push(Prisma.sql`a."state" = ${query.filters.state}`);
  const search = searchSql(query.q);
  if (search) conditions.push(search);
  return andAll(conditions);
}

export function customerListOrderBy(sort: { id: CustomerSort; desc: boolean }): Prisma.Sql {
  const dir = sqlDirection(sort.desc);
  const tie = Prisma.sql`a."id" ${dir}`;
  const nullsLast = Prisma.raw("NULLS LAST");
  switch (sort.id) {
    case "name":
      return Prisma.sql`lower(COALESCE(o."name", a."legalName")) ${dir}, ${tie}`;
    case "business":
      return Prisma.sql`lower(a."legalName") ${dir}, ${tie}`;
    case "state":
      return Prisma.sql`NULLIF(a."state", '') ${dir} ${nullsLast}, ${tie}`;
    case "licenses":
      return Prisma.sql`lic."active" ${dir}, ${tie}`;
    case "orders":
      return Prisma.sql`s."orders" ${dir}, ${tie}`;
    case "ltv":
      return Prisma.sql`s."ltv" ${dir}, ${tie}`;
    case "lastOrder":
      return Prisma.sql`s."lastOrderAt" ${dir} ${nullsLast}, ${tie}`;
  }
}

type CustomerSqlRow = {
  id: string;
  legalName: string;
  gstin: string | null;
  state: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerVerifiedAt: unknown;
  orders: number;
  ltv: bigint | number | string;
  lastOrderAt: Date | string | null;
  active: number;
};

/** Raw timestamp(3) values arrive as Date or as "YYYY-MM-DD HH:MM:SS.mmm" text in UTC. */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = value.includes("T") ? value : value.replace(" ", "T");
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`).toISOString();
}

function toRow(r: CustomerSqlRow): AdminCustomerRow {
  return {
    id: r.id,
    legalName: r.legalName,
    gstin: r.gstin || null,
    state: r.state || null,
    ownerName: r.ownerName,
    ownerEmail: r.ownerEmail,
    ownerVerified: r.ownerId === null ? null : r.ownerVerifiedAt !== null,
    activeLicenses: Number(r.active ?? 0),
    orders: Number(r.orders ?? 0),
    lifetimeValuePaise: Number(r.ltv ?? 0),
    lastOrderAt: toIso(r.lastOrderAt),
  };
}

async function selectCustomers(db: Db, where: Prisma.Sql, orderBy: Prisma.Sql, now: Date, skip: number, take: number) {
  return db.$queryRaw<CustomerSqlRow[]>`
    SELECT ${SELECT_COLUMNS} FROM ${fromSql(now)}
    WHERE ${where} ORDER BY ${orderBy} LIMIT ${take} OFFSET ${skip}`;
}

/** Sorts on an order aggregate, read from the lateral `g` in selectCustomerPage(). */
const ORDER_AGGREGATE_SORTS: Partial<Record<CustomerSort, Prisma.Sql>> = {
  ltv: Prisma.sql`COALESCE(g."ltv", 0)`,
  orders: Prisma.sql`COALESCE(g."orders", 0)`,
  lastOrder: Prisma.sql`g."lastOrderAt"`,
};

/**
 * A page of customer rows in `sort` order. Sorts on an order aggregate first pick the page's account ids with that
 * aggregate alone, then load the full rows (owner, licenses) of that page only, instead of computing every
 * aggregate for every matching account. Order and ties (account id) are those of customerListOrderBy().
 */
async function selectCustomerPage(
  db: Db,
  where: Prisma.Sql,
  sort: { id: CustomerSort; desc: boolean },
  now: Date,
  skip: number,
  take: number,
): Promise<CustomerSqlRow[]> {
  const key = ORDER_AGGREGATE_SORTS[sort.id];
  if (!key) return selectCustomers(db, where, customerListOrderBy(sort), now, skip, take);
  const dir = sqlDirection(sort.desc);
  const nulls = sort.id === "lastOrder" ? Prisma.raw("NULLS LAST") : Prisma.empty;
  const page = await db.$queryRaw<{ id: string }[]>`
    SELECT a."id" FROM "BusinessAccount" a
    LEFT JOIN LATERAL (SELECT ${ORDER_AGGREGATE_COLUMNS} FROM "Order" x WHERE x."accountId" = a."id") g ON TRUE
    WHERE ${where} ORDER BY ${key} ${dir} ${nulls}, a."id" ${dir} LIMIT ${take} OFFSET ${skip}`;
  if (page.length === 0) return [];
  const ids = page.map((r) => r.id);
  const rows = await db.$queryRaw<CustomerSqlRow[]>`
    SELECT ${SELECT_COLUMNS} FROM ${fromSql(now)} WHERE a."id" IN (${Prisma.join(ids)})`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is CustomerSqlRow => r !== undefined);
}

export type AdminCustomerList = { items: AdminCustomerRow[]; total: number };

/** One page of the customers table. */
export async function listAdminCustomers(db: Db, query: CustomerListQuery, now: Date): Promise<AdminCustomerList> {
  const where = customerListWhere(query);
  const skip = (query.page - 1) * query.pageSize;
  const [rows, counted] = await Promise.all([
    selectCustomerPage(db, where, query.sort, now, skip, query.pageSize),
    db.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS "total" FROM "BusinessAccount" a WHERE ${where}`,
  ]);
  return { items: rows.map(toRow), total: counted[0]?.total ?? 0 };
}

/** Every matching account, up to `limit` rows (CSV export). */
export async function exportAdminCustomers(db: Db, query: CustomerListQuery, now: Date, limit: number): Promise<AdminCustomerRow[]> {
  const rows = await selectCustomerPage(db, customerListWhere(query), query.sort, now, 0, limit);
  return rows.map(toRow);
}

/** One account's row (drawer facts), or null. */
export async function getAdminCustomerRow(db: Db, id: string, now: Date): Promise<AdminCustomerRow | null> {
  const rows = await selectCustomers(db, Prisma.sql`a."id" = ${id}`, Prisma.sql`a."id"`, now, 0, 1);
  return rows[0] ? toRow(rows[0]) : null;
}

/** State filter options: the states customer accounts are registered in. */
export async function customerStateOptions(db: Db): Promise<string[]> {
  const rows = await db.businessAccount.findMany({
    where: { state: { not: null } },
    distinct: ["state"],
    orderBy: { state: "asc" },
    select: { state: true },
  });
  return rows.map((r) => r.state).filter((s): s is string => !!s && s.trim() !== "");
}

/** "Medical · Annual license × 3, Restaurant · Device add-on" (prototype orderLines). */
export function orderLinesLabel(items: readonly { quantity: number; plan: { name: string; product: { shortName: string } } }[]): string {
  return items.map((i) => `${i.plan.product.shortName} \u00B7 ${i.plan.name}${i.quantity > 1 ? ` \u00D7 ${i.quantity}` : ""}`).join(", ");
}

/** The customer drawer, or null for an unknown account. Never returns password hashes (only whether one is set). */
export async function getAdminCustomerDetail(db: Db, id: string, now: Date): Promise<AdminCustomerDetail | null> {
  const account = await db.businessAccount.findUnique({
    where: { id },
    select: { id: true, legalName: true, gstin: true, address: true, city: true, state: true, pin: true, createdAt: true },
  });
  if (!account) return null;
  const [row, members, licenses, licensesTotal, orders, ordersTotal, tickets, ticketsTotal] = await Promise.all([
    getAdminCustomerRow(db, id, now),
    db.accountMember.findMany({
      where: { accountId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
      select: {
        role: true,
        status: true,
        user: { select: { id: true, kind: true, name: true, email: true, phone: true, emailVerifiedAt: true, passwordHash: true, createdByStaffId: true } },
      },
    }),
    db.license.findMany({
      where: { accountId: id },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      take: CUSTOMER_DETAIL_LICENSES,
      select: { id: true, status: true, expiresAt: true, productId: true, product: { select: { name: true } }, plan: { select: { name: true, type: true } } },
    }),
    db.license.count({ where: { accountId: id } }),
    db.order.findMany({
      where: { accountId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CUSTOMER_DETAIL_ORDERS,
      select: {
        id: true,
        totalPaise: true,
        status: true,
        createdAt: true,
        items: { orderBy: { id: "asc" }, select: { quantity: true, plan: { select: { name: true, product: { select: { shortName: true } } } } } },
      },
    }),
    db.order.count({ where: { accountId: id } }),
    db.supportTicket.findMany({
      where: { accountId: id },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: CUSTOMER_DETAIL_TICKETS,
      select: { id: true, subject: true, status: true, updatedAt: true },
    }),
    db.supportTicket.count({ where: { accountId: id } }),
  ]);
  const memberRows = members.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    phone: m.user.phone,
    role: m.role,
    status: m.status,
    verified: m.user.emailVerifiedAt !== null,
    hasPassword: m.user.passwordHash !== null,
    createdByStaff: m.user.createdByStaffId !== null,
    canSetPassword: m.status === "ACTIVE" && m.user.kind === "CUSTOMER" && m.user.passwordHash === null,
  }));
  // The owner is the first active OWNER membership (the same rule as the list's lateral join).
  const owner = memberRows.find((m) => m.role === "OWNER" && m.status === "ACTIVE") ?? null;
  return {
    id: account.id,
    legalName: account.legalName,
    gstin: account.gstin || null,
    address: account.address,
    city: account.city,
    state: account.state,
    pin: account.pin,
    createdAt: account.createdAt.toISOString(),
    owner,
    members: memberRows.map(({ phone: _phone, ...m }): AdminCustomerMember => m),
    lifetimeValuePaise: row?.lifetimeValuePaise ?? 0,
    ordersCount: row?.orders ?? 0,
    lastOrderAt: row?.lastOrderAt ?? null,
    licenses: licenses.map((l) => ({
      id: l.id,
      productId: l.productId,
      productName: l.product.name,
      planName: l.plan.name,
      planType: l.plan.type,
      status: deriveLicenseStatus(l, now),
      expiresAt: l.expiresAt?.toISOString() ?? null,
    })),
    licensesTotal,
    orders: orders.map((o) => ({ id: o.id, totalPaise: o.totalPaise, status: o.status, createdAt: o.createdAt.toISOString(), lines: orderLinesLabel(o.items) })),
    ordersTotal,
    tickets: tickets.map((t) => ({ id: t.id, subject: t.subject, status: t.status, updatedAt: t.updatedAt.toISOString() })),
    ticketsTotal,
  };
}
