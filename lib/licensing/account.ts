/**
 * Customer-portal license plumbing (api-contracts section 5; decisions.md Phase 4 "Account license actions"): the
 * guard every /api/account/licenses|devices route calls, and the read models behind the license list, the license
 * detail and the device fleet.
 *
 * Everything is scoped to the active business account resolved on the server (requireAccountRole). Ids from the
 * client only ever select rows inside that account, so another account's license, device or location reads exactly
 * like an unknown id (404). Unclaimed guest licenses (accountId null) are never returned.
 * Keys are always masked here; the full key is only returned by the password-gated reveal (./reveal.ts).
 */
import "server-only";
import type { NextRequest } from "next/server";
import {
  LicenseStatus,
  PlanType,
  type BillingInterval,
  type PublishStatus,
  type Prisma,
  type TeamRole,
} from "@/generated/prisma/client";
import { assertCsrf, csrfBinding } from "@/lib/auth/csrf";
import { requireAccountRole, TEAM_FORBIDDEN_MESSAGE, type AccountContext } from "@/lib/auth/guards";
import { servesExistingLicenses } from "@/lib/catalog/status";
import { getSetting } from "@/lib/config";
import { DAY_MS, maxDate } from "@/lib/dates";
import type { Db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ApiError, errors } from "@/lib/http";
import { teamCan, type TeamPermission } from "@/lib/rbac";
import type { DeviceListQuery, LicenseListQuery, LicenseSortKey } from "@/lib/validation/license-actions";
import { countActiveDevices, countActiveDevicesForAccount } from "./device-limit";
import { maskLicenseKey } from "./keys";
import {
  deriveLicenseStatus,
  EXPIRING_DAYS,
  LICENSE_STATUS_META,
  selfServiceResetsLeft,
  updatesActive,
  type DerivedLicenseStatus,
} from "./status";

export const EMAIL_UNVERIFIED_MESSAGE = "Verify your email to continue.";
/** Devices not seen for this long show as "Inactive 30d+" (portal prototype). */
export const STALE_DEVICE_DAYS = 30;
/** Hard caps on one response; accounts this large need paging (Phase 5 can add it without changing the shape). */
export const LICENSE_LIST_LIMIT = 1000;
export const DEVICE_LIST_LIMIT = 500;
export const LICENSE_DEVICES_LIMIT = 200;
export const LICENSE_HISTORY_LIMIT = 100;
/** Location label for devices without one (portal prototype "Unassigned"). */
export const UNASSIGNED_LOCATION = "Unassigned";

// ---------- Guard ----------

export type LicenseMemberOptions = {
  /** Team permission required on top of membership (reads use "licenses.view", which every role holds). */
  perm?: TeamPermission;
  /** Mutations also pass the same-origin and double-submit CSRF checks (403 csrf_failed). */
  mutation?: boolean;
};

/**
 * Session + active business account + verified email + team permission, in that order: 401 signed out, 403
 * `no_account`, 403 `csrf_failed` (mutations), 403 `email_unverified`, 403 `forbidden` for the role. The account is
 * never taken from the client.
 */
export async function requireLicenseMember(req: NextRequest, opts: LicenseMemberOptions = {}): Promise<AccountContext> {
  const ctx = await requireAccountRole();
  if (opts.mutation) {
    const env = getEnv();
    assertCsrf(req, { binding: csrfBinding(ctx.session.id), secret: env.CSRF_SECRET, appUrl: env.APP_URL });
  }
  if (!ctx.user.emailVerifiedAt) throw new ApiError(403, "email_unverified", EMAIL_UNVERIFIED_MESSAGE);
  if (opts.perm && !teamCan(ctx.membership.role, opts.perm)) throw errors.forbidden(TEAM_FORBIDDEN_MESSAGE);
  return ctx;
}

/** Self-service deactivations per license per IST calendar year (Admin > Settings > licensing, default 3). */
export async function selfServiceLimit(db: Db): Promise<number> {
  return (await getSetting(db, "licensing")).selfServiceResetsPerYear;
}

// ---------- Shared shapes ----------

export type AccountScope = { accountId: string; role: TeamRole };

export type AccountLicenseRow = {
  id: string;
  productId: string;
  productName: string;
  productShortName: string;
  productIcon: string;
  productTone: string;
  planId: string;
  planName: string;
  planType: PlanType;
  keyMasked: string;
  keyLast4: string;
  /** Derived: active | expiring | expired | trial | suspended | revoked. */
  status: DerivedLicenseStatus;
  issuedAt: string;
  expiresAt: string | null;
  updatesUntil: string;
  deviceLimit: number;
  devicesUsed: number;
  orderId: string | null;
};

export type AccountDevice = {
  id: string;
  name: string;
  os: string;
  appVersion: string | null;
  licenseId: string;
  productId: string;
  productName: string;
  productShortName: string;
  locationId: string | null;
  /** Location name, or "Unassigned". */
  locationName: string;
  activatedAt: string;
  lastSeenAt: string;
  deactivatedAt: string | null;
  /** customer | device | staff | system (device limit lowered) */
  deactivatedBy: string | null;
  active: boolean;
  /** Active but not seen for STALE_DEVICE_DAYS ("Inactive 30d+"). */
  stale: boolean;
  /** The viewer may deactivate it now: active device, usable license, `devices.manage`. */
  canDeactivate: boolean;
};

export const ACCOUNT_DEVICE_SELECT = {
  id: true,
  name: true,
  os: true,
  appVersion: true,
  locationId: true,
  activatedAt: true,
  lastSeenAt: true,
  deactivatedAt: true,
  deactivatedBy: true,
  location: { select: { name: true } },
  license: {
    select: {
      id: true,
      status: true,
      expiresAt: true,
      product: { select: { id: true, name: true, shortName: true } },
    },
  },
} as const satisfies Prisma.DeviceActivationSelect;

export type AccountDeviceRecord = Prisma.DeviceActivationGetPayload<{ select: typeof ACCOUNT_DEVICE_SELECT }>;

export function isStaleDevice(device: { deactivatedAt: Date | null; lastSeenAt: Date }, now: Date): boolean {
  return device.deactivatedAt === null && now.getTime() - device.lastSeenAt.getTime() > STALE_DEVICE_DAYS * DAY_MS;
}

/** Whether the license's devices may be managed (prototype canAct: active, expiring or trial). */
export function licenseAllowsDeviceChanges(license: { status: LicenseStatus; expiresAt: Date | null }, now: Date): boolean {
  return LICENSE_STATUS_META[deriveLicenseStatus(license, now)].usable;
}

export function toAccountDevice(record: AccountDeviceRecord, role: TeamRole, now: Date): AccountDevice {
  const active = record.deactivatedAt === null;
  return {
    id: record.id,
    name: record.name,
    os: record.os,
    appVersion: record.appVersion,
    licenseId: record.license.id,
    productId: record.license.product.id,
    productName: record.license.product.name,
    productShortName: record.license.product.shortName,
    locationId: record.locationId,
    locationName: record.location?.name ?? UNASSIGNED_LOCATION,
    activatedAt: record.activatedAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    deactivatedAt: record.deactivatedAt ? record.deactivatedAt.toISOString() : null,
    deactivatedBy: record.deactivatedBy,
    active,
    stale: isStaleDevice(record, now),
    canDeactivate: active && licenseAllowsDeviceChanges(record.license, now) && teamCan(role, "devices.manage"),
  };
}

// ---------- License list ----------

const LICENSE_ROW_SELECT = {
  id: true,
  productId: true,
  planId: true,
  status: true,
  issuedAt: true,
  expiresAt: true,
  updatesUntil: true,
  deviceLimit: true,
  keyLast4: true,
  orderId: true,
  product: {
    select: { id: true, code: true, name: true, shortName: true, icon: true, tone: true, category: { select: { tone: true } } },
  },
  plan: { select: { id: true, name: true, type: true } },
  // No `_count` of devices here: Prisma aggregates the whole DeviceActivation table for it (decisions.md Phase 4 fix
  // pass); devicesUsed comes from countActiveDevices() for the listed ids.
} as const satisfies Prisma.LicenseSelect;

type LicenseRowRecord = Prisma.LicenseGetPayload<{ select: typeof LICENSE_ROW_SELECT }>;

function toLicenseRow(record: LicenseRowRecord, devicesUsed: number, now: Date): AccountLicenseRow {
  return {
    id: record.id,
    productId: record.product.id,
    productName: record.product.name,
    productShortName: record.product.shortName,
    productIcon: record.product.icon,
    productTone: record.product.tone ?? record.product.category.tone,
    planId: record.plan.id,
    planName: record.plan.name,
    planType: record.plan.type,
    keyMasked: maskLicenseKey(record.product.code, record.keyLast4),
    keyLast4: record.keyLast4,
    status: deriveLicenseStatus(record, now),
    issuedAt: record.issuedAt.toISOString(),
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    updatesUntil: record.updatesUntil.toISOString(),
    deviceLimit: record.deviceLimit,
    devicesUsed,
    orderId: record.orderId,
  };
}

/** SQL form of deriveLicenseStatus() for one derived status, so filtering happens in the database. */
export function derivedStatusWhere(status: LicenseListQuery["status"], now: Date): Prisma.LicenseWhereInput {
  const expiringBefore = new Date(now.getTime() + EXPIRING_DAYS * DAY_MS);
  switch (status) {
    case "all":
      return {};
    case "revoked":
      return { status: LicenseStatus.REVOKED };
    case "suspended":
      return { status: LicenseStatus.SUSPENDED };
    case "expired":
      return { status: { in: [LicenseStatus.ACTIVE, LicenseStatus.TRIAL] }, expiresAt: { lte: now } };
    case "trial":
      return { status: LicenseStatus.TRIAL, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
    case "expiring":
      return { status: LicenseStatus.ACTIVE, expiresAt: { gt: now, lt: expiringBefore } };
    case "active":
      return { status: LicenseStatus.ACTIVE, OR: [{ expiresAt: null }, { expiresAt: { gte: expiringBefore } }] };
  }
}

/** License id, product name or the key's last four characters (as the prototype's search). */
function licenseSearchWhere(q: string): Prisma.LicenseWhereInput {
  if (q === "") return {};
  return {
    OR: [
      { id: { contains: q, mode: "insensitive" } },
      { product: { name: { contains: q, mode: "insensitive" } } },
      { product: { shortName: { contains: q, mode: "insensitive" } } },
      { keyLast4: { contains: q.toUpperCase() } },
    ],
  };
}

const SORT_VALUE: Record<LicenseSortKey, (row: AccountLicenseRow) => number | string> = {
  product: (row) => row.productName.toLowerCase(),
  status: (row) => row.status,
  // Perpetual licenses have no end date and sort last when ascending.
  expiry: (row) => (row.expiresAt ? Date.parse(row.expiresAt) : Number.POSITIVE_INFINITY),
  devices: (row) => (row.deviceLimit > 0 ? row.devicesUsed / row.deviceLimit : 0),
  updates: (row) => Date.parse(row.updatesUntil),
};

/** The prototype's column sorts (product, status, expiry, devices used/limit, updates until); ties by license id. */
export function sortLicenseRows(rows: readonly AccountLicenseRow[], sort: LicenseListQuery["sort"]): AccountLicenseRow[] {
  const value = SORT_VALUE[sort.key];
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const byValue = x > y ? 1 : x < y ? -1 : 0;
    if (byValue !== 0) return byValue * sort.dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type AccountLicenseList = {
  licenses: AccountLicenseRow[];
  /** Every license the account holds, for "3 of 5 licenses". */
  total: number;
  /** More rows matched than LICENSE_LIST_LIMIT. */
  truncated: boolean;
  /** Products the account holds licenses for (the product filter). */
  products: Array<{ id: string; name: string; shortName: string }>;
};

export async function listAccountLicenses(db: Db, scope: AccountScope, query: LicenseListQuery, now: Date): Promise<AccountLicenseList> {
  const where: Prisma.LicenseWhereInput = {
    accountId: scope.accountId,
    ...(query.product === "all" ? {} : { productId: query.product }),
    AND: [derivedStatusWhere(query.status, now), licenseSearchWhere(query.q)],
  };
  const records = await db.license.findMany({ where, select: LICENSE_ROW_SELECT, orderBy: { id: "asc" }, take: LICENSE_LIST_LIMIT + 1 });
  const total = await db.license.count({ where: { accountId: scope.accountId } });
  const products = await db.product.findMany({
    where: { licenses: { some: { accountId: scope.accountId } } },
    select: { id: true, name: true, shortName: true },
    orderBy: [{ rank: "asc" }, { name: "asc" }],
  });
  const listed = records.slice(0, LICENSE_LIST_LIMIT);
  const devicesUsed = await countActiveDevices(db, listed.map((r) => r.id));
  const rows = listed.map((r) => toLicenseRow(r, devicesUsed.get(r.id) ?? 0, now));
  return { licenses: sortLicenseRows(rows, query.sort), total, truncated: records.length > LICENSE_LIST_LIMIT, products };
}

// ---------- License detail ----------

/** History labels for LicenseEvent.type (schema comment list), in the portal prototype's wording where it has one. */
export const LICENSE_EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  issued: "License issued",
  activated: "Activated",
  deactivated: "Deactivated",
  key_revealed: "Key revealed",
  key_delivered: "Key delivered",
  suspended: "Suspended",
  reinstated: "Reinstated",
  revoked: "Revoked",
  extended: "Extended",
  renewed: "Renewed",
  upgraded: "Upgraded",
  devices_added: "Devices added",
  devices_reset: "Devices reset",
  trial_started: "Trial started",
  trial_ended: "Trial ended",
  updates_ended: "Updates period ended",
  terms_restored: "Terms restored",
});

export function licenseEventLabel(type: string): string {
  if (Object.hasOwn(LICENSE_EVENT_LABELS, type)) return LICENSE_EVENT_LABELS[type] ?? type;
  const words = type.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Event";
}

export type LicenseHistoryEntry = { id: string; type: string; label: string; actor: string; detail: string | null; at: string };

export type RenewalOptionTag = "BUY" | "RENEWAL" | "MAINTENANCE" | "ADD-ON" | "UPGRADE";

/** One card of the license's "Renew & upgrade" tab; the cart re-prices everything on the server. */
export type RenewalOption = {
  tag: RenewalOptionTag;
  /** Cart item kind. BUY converts a trial (UPGRADE) to a plan the customer picks on the product page. */
  kind: "RENEWAL" | "UPGRADE" | "ADDON";
  planId: string;
  planName: string;
  planType: PlanType;
  interval: BillingInterval | null;
  /** Cart quantity: device slots for per-unit renewals, otherwise 1 (add-ons are priced per computer). */
  qty: number;
  unitPricePaise: number;
  /** unitPricePaise * qty, excluding GST. */
  pricePaise: number;
  /** When the new term (RENEWAL) or updates period (MAINTENANCE) starts counting; null otherwise. */
  from: string | null;
  /** False when the license cannot take it right now (adding computers to an expired or suspended license). */
  available: boolean;
};

const RENEWAL_PLAN_SELECT = {
  id: true,
  name: true,
  type: true,
  interval: true,
  pricePaise: true,
  perUnit: true,
  maxQty: true,
  multiDevice: true,
  archived: true,
  sortOrder: true,
} as const satisfies Prisma.PlanSelect;

export type RenewalPlan = Prisma.PlanGetPayload<{ select: typeof RENEWAL_PLAN_SELECT }>;

export type RenewalLicense = {
  status: LicenseStatus;
  expiresAt: Date | null;
  updatesUntil: Date;
  deviceLimit: number;
  plan: RenewalPlan;
  productStatus: PublishStatus;
};

/** Quantity cap for per-unit plans without maxQty (lib/pricing DEFAULT_MAX_QTY). */
const PER_UNIT_MAX_QTY = 10;
const PAID_PLAN_TYPES: readonly PlanType[] = [PlanType.ONE_TIME, PlanType.ANNUAL, PlanType.SUBSCRIPTION];
const TIME_LIMITED_PLAN_TYPES: readonly PlanType[] = [PlanType.ANNUAL, PlanType.SUBSCRIPTION];

/**
 * Renewal, maintenance, add-on and upgrade offers for one license, following the checkout rules (lib/checkout/lines)
 * and the portal prototype: nothing for revoked licenses or draft and coming-soon products; a trial converts through an UPGRADE to
 * the cheapest paid plan (no renewal or add-on on a trial); a perpetual license renews updates through MAINTENANCE; an
 * annual or subscription license renews its own plan (archived plans still renew); add-ons need a usable license;
 * an active annual or subscription license may switch to a single-device one-time plan.
 */
export function renewalOptionsFor(license: RenewalLicense, plans: readonly RenewalPlan[], now: Date): RenewalOption[] {
  if (license.status === LicenseStatus.REVOKED || !servesExistingLicenses(license.productStatus)) return [];
  const live = plans
    .filter((p) => !p.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.pricePaise - b.pricePaise || (a.id < b.id ? -1 : 1));
  const option = (
    tag: RenewalOptionTag,
    kind: RenewalOption["kind"],
    plan: RenewalPlan,
    qty: number,
    from: Date | null,
    available: boolean,
  ): RenewalOption => ({
    tag,
    kind,
    planId: plan.id,
    planName: plan.name,
    planType: plan.type,
    interval: plan.interval,
    qty,
    unitPricePaise: plan.pricePaise,
    pricePaise: plan.pricePaise * qty,
    from: from ? from.toISOString() : null,
    available,
  });

  if (license.status === LicenseStatus.TRIAL) {
    const starting = live
      .filter((p) => PAID_PLAN_TYPES.includes(p.type) && p.pricePaise > 0)
      .sort((a, b) => a.pricePaise - b.pricePaise)[0];
    return starting ? [option("BUY", "UPGRADE", starting, 1, null, true)] : [];
  }

  const out: RenewalOption[] = [];
  if (license.expiresAt === null) {
    const maintenance = live.find((p) => p.type === PlanType.MAINTENANCE);
    if (maintenance) out.push(option("MAINTENANCE", "RENEWAL", maintenance, 1, maxDate(license.updatesUntil, now), true));
  } else if (TIME_LIMITED_PLAN_TYPES.includes(license.plan.type)) {
    const plan = license.plan;
    const qty = plan.perUnit ? Math.max(1, Math.min(license.deviceLimit, plan.maxQty ?? PER_UNIT_MAX_QTY)) : 1;
    out.push(option("RENEWAL", "RENEWAL", plan, qty, maxDate(license.expiresAt, now), true));
  }
  const addon = live.find((p) => p.type === PlanType.DEVICE_ADDON);
  if (addon) out.push(option("ADD-ON", "ADDON", addon, 1, null, licenseAllowsDeviceChanges(license, now)));
  if (license.status === LicenseStatus.ACTIVE && license.expiresAt !== null && TIME_LIMITED_PLAN_TYPES.includes(license.plan.type)) {
    const oneTime = live.find((p) => p.type === PlanType.ONE_TIME && !p.multiDevice);
    if (oneTime) out.push(option("UPGRADE", "UPGRADE", oneTime, 1, null, true));
  }
  return out;
}

export type AccountLicenseDetail = {
  license: AccountLicenseRow & {
    planInterval: BillingInterval | null;
    /** Device word: "terminal" for per-unit plans, else "computer". */
    unit: string;
    updatesActive: boolean;
    revokedAt: string | null;
    revokedReason: string | null;
    selfServiceResetsLeft: number;
    selfServiceResetsPerYear: number;
    /** The viewer may reveal the key (not revoked, `keys.reveal`). */
    canReveal: boolean;
    /** The viewer may deactivate devices (usable license, `devices.manage`). */
    canManageDevices: boolean;
  };
  /** Active devices first, then deactivated ones (most recent first). */
  devices: AccountDevice[];
  /** LicenseEvent rows, newest first (routine validations are never recorded). */
  history: LicenseHistoryEntry[];
  renewalOptions: RenewalOption[];
  /** The account's locations, for the device location picker. */
  locations: Array<{ id: string; name: string }>;
};

/** One license of the account with devices, history and renewal options; 404 for anything outside the account. */
export async function getAccountLicenseDetail(db: Db, scope: AccountScope, licenseId: string, now: Date): Promise<AccountLicenseDetail> {
  const record = await db.license.findFirst({
    where: { id: licenseId, accountId: scope.accountId },
    select: {
      ...LICENSE_ROW_SELECT,
      revokedAt: true,
      revokedReason: true,
      selfServiceResets: true,
      resetsYear: true,
      product: { select: { ...LICENSE_ROW_SELECT.product.select, status: true } },
      plan: { select: RENEWAL_PLAN_SELECT },
      events: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: LICENSE_HISTORY_LIMIT,
        select: { id: true, type: true, actor: true, detail: true, createdAt: true },
      },
    },
  });
  if (!record) throw errors.notFound("License");

  const devices = await db.deviceActivation.findMany({
    where: { licenseId: record.id },
    orderBy: [{ deactivatedAt: { sort: "desc", nulls: "first" } }, { lastSeenAt: "desc" }, { id: "asc" }],
    take: LICENSE_DEVICES_LIMIT,
    select: ACCOUNT_DEVICE_SELECT,
  });
  const plans = await db.plan.findMany({ where: { productId: record.productId }, select: RENEWAL_PLAN_SELECT });
  const locations = await db.location.findMany({
    where: { accountId: scope.accountId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  const perYear = await selfServiceLimit(db);
  const devicesUsed = (await countActiveDevices(db, [record.id])).get(record.id) ?? 0;
  const derived = deriveLicenseStatus(record, now);

  return {
    license: {
      ...toLicenseRow(record, devicesUsed, now),
      planInterval: record.plan.interval,
      unit: record.plan.perUnit ? record.plan.perUnit : "computer",
      updatesActive: updatesActive(record, now),
      revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
      revokedReason: record.status === LicenseStatus.REVOKED ? record.revokedReason : null,
      selfServiceResetsLeft: selfServiceResetsLeft(record, now, perYear),
      selfServiceResetsPerYear: perYear,
      canReveal: derived !== "revoked" && teamCan(scope.role, "keys.reveal"),
      canManageDevices: LICENSE_STATUS_META[derived].usable && teamCan(scope.role, "devices.manage"),
    },
    devices: devices.map((d) => toAccountDevice(d, scope.role, now)),
    history: record.events.map((e) => ({
      id: e.id,
      type: e.type,
      label: licenseEventLabel(e.type),
      actor: e.actor,
      detail: e.detail,
      at: e.createdAt.toISOString(),
    })),
    renewalOptions: renewalOptionsFor(
      {
        status: record.status,
        expiresAt: record.expiresAt,
        updatesUntil: record.updatesUntil,
        deviceLimit: record.deviceLimit,
        plan: record.plan,
        productStatus: record.product.status,
      },
      plans,
      now,
    ),
    locations,
  };
}

// ---------- Device fleet ----------

export function deviceStatusWhere(status: DeviceListQuery["status"], now: Date): Prisma.DeviceActivationWhereInput {
  switch (status) {
    case "all":
      return {};
    case "active":
      return { deactivatedAt: null };
    case "inactive":
      return { deactivatedAt: { not: null } };
    case "stale":
      return { deactivatedAt: null, lastSeenAt: { lt: new Date(now.getTime() - STALE_DEVICE_DAYS * DAY_MS) } };
  }
}

function deviceLocationWhere(location: string): Prisma.DeviceActivationWhereInput {
  if (location === "all") return {};
  if (location === "none") return { locationId: null };
  return { locationId: location };
}

function deviceSearchWhere(q: string): Prisma.DeviceActivationWhereInput {
  if (q === "") return {};
  return {
    OR: [
      { name: { contains: q, mode: "insensitive" } },
      { os: { contains: q, mode: "insensitive" } },
      { licenseId: { contains: q, mode: "insensitive" } },
    ],
  };
}

export type AccountDeviceFleet = {
  devices: AccountDevice[];
  /** More devices matched than DEVICE_LIST_LIMIT. */
  truncated: boolean;
  /** Portal stat tiles: active devices, free slots on usable licenses, active devices unseen for 30 days, locations. */
  stats: { activeDevices: number; freeSlots: number; staleDevices: number; locations: number };
  locations: Array<{ id: string; name: string }>;
};

/** Every device on the account's licenses, filtered; active devices first, then the most recently deactivated. */
export async function listAccountDevices(db: Db, scope: AccountScope, query: DeviceListQuery, now: Date): Promise<AccountDeviceFleet> {
  const where: Prisma.DeviceActivationWhereInput = {
    license: { accountId: scope.accountId },
    AND: [deviceStatusWhere(query.status, now), deviceLocationWhere(query.location), deviceSearchWhere(query.q)],
  };
  const records = await db.deviceActivation.findMany({
    where,
    orderBy: [{ deactivatedAt: { sort: "desc", nulls: "first" } }, { lastSeenAt: "desc" }, { id: "asc" }],
    take: DEVICE_LIST_LIMIT + 1,
    select: ACCOUNT_DEVICE_SELECT,
  });
  const licenses = await db.license.findMany({
    where: { accountId: scope.accountId },
    select: { id: true, status: true, expiresAt: true, deviceLimit: true },
  });
  const activeByLicense = await countActiveDevicesForAccount(db, scope.accountId);
  const staleDevices = await db.deviceActivation.count({
    where: { license: { accountId: scope.accountId }, ...deviceStatusWhere("stale", now) },
  });
  const locations = await db.location.findMany({
    where: { accountId: scope.accountId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });

  let activeDevices = 0;
  let freeSlots = 0;
  for (const license of licenses) {
    const active = activeByLicense.get(license.id) ?? 0;
    activeDevices += active;
    if (licenseAllowsDeviceChanges(license, now)) freeSlots += Math.max(0, license.deviceLimit - active);
  }
  return {
    devices: records.slice(0, DEVICE_LIST_LIMIT).map((r) => toAccountDevice(r, scope.role, now)),
    truncated: records.length > DEVICE_LIST_LIMIT,
    stats: { activeDevices, freeSlots, staleDevices, locations: locations.length },
    locations,
  };
}
