/**
 * Admin license reads (Licenses and Renewals modules, Admin Console.dc.html `mods.licenses` + `licDetail`): the
 * filtered and sorted page of licenses (a page of ids by raw SQL, ./sql.ts, then the rows by Prisma), the stats row,
 * the drawer detail and the manual-issue plan options. Keys are always masked: only keyLast4 and the product code are
 * read, never keyCiphertext or keyHash.
 */
import "server-only";
import { PlanType } from "@/generated/prisma/client";
import { DAY_MS, istCalendarYear } from "@/lib/dates";
import { Prisma, type Db } from "@/lib/db";
import { licenseEventLabel, selfServiceLimit } from "@/lib/licensing/account";
import { countActiveDevices } from "@/lib/licensing/device-limit";
import { maskLicenseKey } from "@/lib/licensing/keys";
import { DERIVED_LICENSE_STATUSES, deriveLicenseStatus, EXPIRING_DAYS, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { mergeLicenseHistory } from "./history";
import {
  MANUAL_ISSUE_PLAN_TYPES,
  renewalValuePaise,
  type AdminLicenseDetail,
  type AdminLicenseDevice,
  type AdminLicenseOrder,
  type AdminLicenseRow,
  type AdminLicenseStats,
  type AdminProductOption,
  type LicenseListQuery,
  type LicenseSort,
  type ManualIssuePlanOption,
} from "./model";
import {
  ACTIVE_DEVICES_SQL,
  andAll,
  CUSTOMER_SORT_SQL,
  derivedStatusCaseSql,
  derivedStatusSql,
  inIdOrder,
  licenseSearchSql,
  pageLicenseIds,
  sqlDirection,
} from "./sql";

/** Drawer limits: devices listed, history rows (prototype: 12) and related orders. */
export const DETAIL_DEVICE_LIMIT = 50;
export const DETAIL_HISTORY_LIMIT = 12;
export const DETAIL_ORDER_LIMIT = 8;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function isDerivedStatus(value: string | undefined): value is DerivedLicenseStatus {
  return value !== undefined && (DERIVED_LICENSE_STATUSES as readonly string[]).includes(value);
}

// ---------- Customers of licenses ----------

type AccountContact = { legalName: string; ownerName: string | null; ownerEmail: string | null };
type OrderContact = { email: string; name: string | null; business: string | null };

/** Who a license belongs to, as the tables show it: the business (or the guest buyer) and an email to reach them. */
export type LicenseCustomer = {
  /** Business name, else the guest buyer's business or name, else their email. */
  customerName: string;
  customerEmail: string | null;
  businessName: string | null;
  contactName: string | null;
};

/**
 * Account owners and guest order buyers for a set of licenses, in two queries: the account's first active Owner
 * (by membership age), and the issuing order's billing snapshot for unclaimed guest licenses.
 */
export async function loadLicenseCustomers(
  db: Db,
  licenses: readonly { accountId: string | null; orderId: string | null }[],
): Promise<(license: { accountId: string | null; orderId: string | null }) => LicenseCustomer> {
  const accountIds = [...new Set(licenses.map((l) => l.accountId).filter((id): id is string => id !== null))];
  const orderIds = [...new Set(licenses.filter((l) => l.accountId === null && l.orderId).map((l) => l.orderId as string))];
  const [accounts, orders] = await Promise.all([
    accountIds.length === 0
      ? []
      : db.businessAccount.findMany({
          where: { id: { in: accountIds } },
          select: {
            id: true,
            legalName: true,
            members: {
              where: { role: "OWNER", status: "ACTIVE" },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 1,
              select: { user: { select: { name: true, email: true } } },
            },
          },
        }),
    orderIds.length === 0
      ? []
      : db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, email: true, billing: true } }),
  ]);
  const byAccount = new Map<string, AccountContact>(
    accounts.map((a) => [a.id, { legalName: a.legalName, ownerName: a.members[0]?.user.name ?? null, ownerEmail: a.members[0]?.user.email ?? null }]),
  );
  const byOrder = new Map<string, OrderContact>(
    orders.map((o) => {
      const billing = readBillingSnapshot(o.billing);
      return [o.id, { email: o.email, name: billing.name || null, business: billing.business }];
    }),
  );
  return (license) => {
    const account = license.accountId ? byAccount.get(license.accountId) : undefined;
    if (account) {
      return { customerName: account.legalName, customerEmail: account.ownerEmail, businessName: account.legalName, contactName: account.ownerName };
    }
    const order = license.orderId ? byOrder.get(license.orderId) : undefined;
    if (order) {
      return { customerName: order.business ?? order.name ?? order.email, customerEmail: order.email, businessName: order.business, contactName: order.name };
    }
    return { customerName: "Unclaimed license", customerEmail: null, businessName: null, contactName: null };
  };
}

// ---------- Rows ----------

const ROW_SELECT = {
  id: true,
  accountId: true,
  orderId: true,
  productId: true,
  keyLast4: true,
  status: true,
  expiresAt: true,
  issuedAt: true,
  updatesUntil: true,
  deviceLimit: true,
  product: { select: { name: true, shortName: true, code: true } },
  plan: { select: { id: true, name: true, type: true, pricePaise: true, perUnit: true } },
} as const satisfies Prisma.LicenseSelect;

export type LicenseRowRecord = Prisma.LicenseGetPayload<{ select: typeof ROW_SELECT }>;

/** Table rows for these license ids, in the order given (unknown ids are dropped). */
export async function loadLicenseRows(db: Db, ids: readonly string[], now: Date): Promise<AdminLicenseRow[]> {
  const records = await loadLicenseRecords(db, ids);
  return toLicenseRows(db, records, now);
}

export async function loadLicenseRecords(db: Db, ids: readonly string[]): Promise<LicenseRowRecord[]> {
  if (ids.length === 0) return [];
  const records = await db.license.findMany({ where: { id: { in: [...ids] } }, select: ROW_SELECT });
  return inIdOrder(ids, records);
}

export async function toLicenseRows(db: Db, records: readonly LicenseRowRecord[], now: Date): Promise<AdminLicenseRow[]> {
  const [customerOf, devices] = await Promise.all([
    loadLicenseCustomers(db, records),
    countActiveDevices(db, records.map((r) => r.id)),
  ]);
  return records.map((r) => {
    const customer = customerOf(r);
    return {
      id: r.id,
      productId: r.productId,
      productName: r.product.name,
      productShortName: r.product.shortName,
      planName: r.plan.name,
      keyMasked: maskLicenseKey(r.product.code, r.keyLast4),
      status: deriveLicenseStatus(r, now),
      customerName: customer.customerName,
      customerEmail: customer.customerEmail,
      accountId: r.accountId,
      expiresAt: iso(r.expiresAt),
      issuedAt: r.issuedAt.toISOString(),
      deviceLimit: r.deviceLimit,
      devicesUsed: devices.get(r.id) ?? 0,
    };
  });
}

// ---------- List ----------

/** WHERE clause for the Licenses list: derived status, product, devices (at limit / none) and the search. */
export function licenseListWhere(query: Pick<LicenseListQuery, "q" | "filters">, now: Date): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  const { status, product, devices } = query.filters;
  if (isDerivedStatus(status)) conditions.push(derivedStatusSql(status, now));
  if (product) conditions.push(Prisma.sql`l."productId" = ${product}`);
  if (devices === "full") conditions.push(Prisma.sql`${ACTIVE_DEVICES_SQL} >= l."deviceLimit"`);
  if (devices === "none") {
    conditions.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "DeviceActivation" d WHERE d."licenseId" = l."id" AND d."deactivatedAt" IS NULL)`);
  }
  const search = licenseSearchSql(query.q);
  if (search) conditions.push(search);
  return andAll(conditions);
}

/** ORDER BY for a Licenses sort, with the id as the tie-breaker (stable offset paging). */
export function licenseListOrderBy(sort: { id: LicenseSort; desc: boolean }, now: Date): Prisma.Sql {
  const dir = sqlDirection(sort.desc);
  // LIC- ids grow a digit after LIC-99999: compare by length first so they sort numerically.
  const byId = Prisma.sql`length(l."id") ${dir}, l."id" ${dir}`;
  switch (sort.id) {
    case "id":
      return byId;
    case "customer":
      return Prisma.sql`${CUSTOMER_SORT_SQL} ${dir}, ${byId}`;
    case "status":
      return Prisma.sql`${derivedStatusCaseSql(now)} ${dir}, ${byId}`;
    case "expires":
      // Postgres puts NULL (no end date) last ascending and first descending, as the prototype's 9e15 did.
      return Prisma.sql`l."expiresAt" ${dir}, ${byId}`;
    case "devices":
      return Prisma.sql`(${ACTIVE_DEVICES_SQL})::float8 / GREATEST(l."deviceLimit", 1) ${dir}, ${byId}`;
    case "issued":
      return Prisma.sql`l."issuedAt" ${dir}, ${byId}`;
  }
}

export type AdminLicenseList = { items: AdminLicenseRow[]; total: number };

/** One page of the Licenses table for the list query. */
export async function listAdminLicenses(db: Db, query: LicenseListQuery, now: Date): Promise<AdminLicenseList> {
  const skip = (query.page - 1) * query.pageSize;
  const { ids, total } = await pageLicenseIds(db, {
    where: licenseListWhere(query, now),
    orderBy: licenseListOrderBy(query.sort, now),
    skip,
    take: query.pageSize,
  });
  return { items: await loadLicenseRows(db, ids, now), total };
}

/** Every license matching the list query, up to `limit` rows (CSV export). */
export async function exportAdminLicenses(db: Db, query: LicenseListQuery, now: Date, limit: number): Promise<AdminLicenseRow[]> {
  const { ids } = await pageLicenseIds(db, { where: licenseListWhere(query, now), orderBy: licenseListOrderBy(query.sort, now), skip: 0, take: limit });
  return loadLicenseRows(db, ids, now);
}

/** Stats row (prototype): ACTIVE (active + expiring), EXPIRING <= 60 DAYS, DEVICES IN USE, SUSPENDED / REVOKED. */
export async function adminLicenseStats(db: Db, now: Date): Promise<AdminLicenseStats> {
  const soon = new Date(now.getTime() + EXPIRING_DAYS * DAY_MS);
  const [counts, devices] = await Promise.all([
    db.$queryRaw<{ active: number; expiring: number; held: number }[]>`
      SELECT
        count(*) FILTER (WHERE l."status" = 'ACTIVE' AND (l."expiresAt" IS NULL OR l."expiresAt" > ${now}::timestamp(3)))::int AS "active",
        count(*) FILTER (WHERE l."status" = 'ACTIVE' AND l."expiresAt" > ${now}::timestamp(3) AND l."expiresAt" < ${soon}::timestamp(3))::int AS "expiring",
        count(*) FILTER (WHERE l."status" IN ('SUSPENDED', 'REVOKED'))::int AS "held"
      FROM "License" l`,
    db.deviceActivation.count({ where: { deactivatedAt: null } }),
  ]);
  const row = counts[0];
  return { active: row?.active ?? 0, expiring: row?.expiring ?? 0, devicesInUse: devices, suspendedOrRevoked: row?.held ?? 0 };
}

/** Product filter options (every product, by name). */
export async function adminProductOptions(db: Db): Promise<AdminProductOption[]> {
  return db.product.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, shortName: true } });
}

/** Plans staff can issue by hand: trial, one-time, annual and subscription plans that are on sale. */
export async function manualIssuePlanOptions(db: Db): Promise<ManualIssuePlanOption[]> {
  const plans = await db.plan.findMany({
    where: { archived: false, type: { in: [...MANUAL_ISSUE_PLAN_TYPES] } },
    orderBy: [{ product: { name: "asc" } }, { sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, name: true, type: true, productId: true, perUnit: true, maxQty: true, product: { select: { name: true } } },
  });
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    productId: p.productId,
    productName: p.product.name,
    perUnit: p.perUnit !== null,
    maxQty: p.maxQty,
  }));
}

// ---------- Drawer ----------

const ITEM_KIND_LABELS: Record<string, string> = { NEW: "New", RENEWAL: "Renewal", UPGRADE: "Upgrade", ADDON: "Add-on" };

function originOf(license: { orderId: string | null; plan: { type: PlanType } }, events: readonly { type: string }[]): string {
  if (license.orderId) return `Order ${license.orderId}`;
  if (license.plan.type === PlanType.TRIAL || events.some((e) => e.type === "trial_started")) return "Trial";
  return "Issued by staff";
}

function toDevice(d: {
  id: string;
  name: string;
  os: string;
  appVersion: string | null;
  fingerprint: string;
  activatedAt: Date;
  lastSeenAt: Date;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
}): AdminLicenseDevice {
  return {
    id: d.id,
    name: d.name,
    os: d.os,
    appVersion: d.appVersion,
    fingerprintShort: d.fingerprint.slice(0, 10),
    activatedAt: d.activatedAt.toISOString(),
    lastSeenAt: d.lastSeenAt.toISOString(),
    deactivatedAt: iso(d.deactivatedAt),
    deactivatedBy: d.deactivatedBy,
    active: d.deactivatedAt === null,
  };
}

/** Orders that issued or changed the license (renewals, add-ons, upgrades), newest first. */
async function licenseOrders(db: Db, license: { id: string; orderId: string | null }): Promise<AdminLicenseOrder[]> {
  const items = await db.orderItem.findMany({
    where: { targetLicenseId: license.id },
    orderBy: { id: "asc" },
    take: 100,
    select: { orderId: true, kind: true },
  });
  const kinds = new Map<string, string>(items.map((i) => [i.orderId, ITEM_KIND_LABELS[i.kind] ?? i.kind]));
  if (license.orderId) kinds.set(license.orderId, ITEM_KIND_LABELS.NEW ?? "New");
  if (kinds.size === 0) return [];
  const orders = await db.order.findMany({
    where: { id: { in: [...kinds.keys()] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: DETAIL_ORDER_LIMIT,
    select: { id: true, status: true, totalPaise: true, createdAt: true },
  });
  return orders.map((o) => ({ id: o.id, kind: kinds.get(o.id) ?? "", status: o.status, totalPaise: o.totalPaise, createdAt: o.createdAt.toISOString() }));
}

/** The license drawer (prototype licDetail), or null for an unknown id. */
export async function getAdminLicenseDetail(db: Db, id: string, now: Date): Promise<AdminLicenseDetail | null> {
  const license = await db.license.findUnique({
    where: { id },
    select: {
      id: true,
      accountId: true,
      orderId: true,
      productId: true,
      planId: true,
      keyLast4: true,
      status: true,
      issuedAt: true,
      expiresAt: true,
      updatesUntil: true,
      deviceLimit: true,
      selfServiceResets: true,
      resetsYear: true,
      revokedAt: true,
      revokedReason: true,
      product: { select: { name: true, shortName: true, code: true } },
      plan: { select: { name: true, type: true, pricePaise: true, perUnit: true } },
    },
  });
  if (!license) return null;

  const [customerOf, devices, devicesTotal, devicesUsed, events, audits, orders, perYear] = await Promise.all([
    loadLicenseCustomers(db, [license]),
    db.deviceActivation.findMany({
      where: { licenseId: id },
      orderBy: [{ deactivatedAt: { sort: "desc", nulls: "first" } }, { activatedAt: "desc" }, { id: "asc" }],
      take: DETAIL_DEVICE_LIMIT,
      select: {
        id: true,
        name: true,
        os: true,
        appVersion: true,
        fingerprint: true,
        activatedAt: true,
        lastSeenAt: true,
        deactivatedAt: true,
        deactivatedBy: true,
      },
    }),
    db.deviceActivation.count({ where: { licenseId: id } }),
    db.deviceActivation.count({ where: { licenseId: id, deactivatedAt: null } }),
    db.licenseEvent.findMany({
      where: { licenseId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DETAIL_HISTORY_LIMIT * 3,
      select: { id: true, type: true, actor: true, detail: true, createdAt: true },
    }),
    db.auditLog.findMany({
      where: { targetType: "license", targetId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DETAIL_HISTORY_LIMIT * 3,
      select: { id: true, action: true, reason: true, detail: true, createdAt: true, actorRole: true, actor: { select: { name: true } } },
    }),
    licenseOrders(db, license),
    selfServiceLimit(db),
  ]);
  const customer = customerOf(license);
  const history = mergeLicenseHistory(
    events,
    audits.map((a) => ({
      id: a.id,
      action: a.action,
      actorName: a.actor?.name ?? (a.actorRole === "system" ? "System" : "Staff"),
      reason: a.reason,
      detail: a.detail,
      createdAt: a.createdAt,
    })),
    licenseEventLabel,
    DETAIL_HISTORY_LIMIT,
  );

  return {
    id: license.id,
    productId: license.productId,
    productName: license.product.name,
    productShortName: license.product.shortName,
    planId: license.planId,
    planName: license.plan.name,
    planType: license.plan.type,
    keyMasked: maskLicenseKey(license.product.code, license.keyLast4),
    status: deriveLicenseStatus(license, now),
    storedStatus: license.status,
    accountId: license.accountId,
    businessName: customer.businessName,
    contactName: customer.contactName,
    contactEmail: customer.customerEmail,
    orderId: license.orderId,
    origin: originOf(license, events),
    issuedAt: license.issuedAt.toISOString(),
    expiresAt: iso(license.expiresAt),
    updatesUntil: license.updatesUntil.toISOString(),
    deviceLimit: license.deviceLimit,
    devicesUsed,
    selfServiceResetsUsed: license.resetsYear === istCalendarYear(now) ? license.selfServiceResets : 0,
    selfServiceResetsPerYear: perYear,
    revokedAt: iso(license.revokedAt),
    revokedReason: license.revokedReason,
    renewalValuePaise: renewalValuePaise(license.plan, license.deviceLimit),
    devices: devices.map(toDevice),
    devicesTotal,
    history,
    orders,
  };
}
