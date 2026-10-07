/**
 * Portal Overview (GET /api/account/overview; Customer Portal prototype vOverview, decisions.md Phase 5):
 * alerts, four KPIs, device-slot utilisation per usable license, the 12-month renewal timeline (IST months), spend
 * by product and the latest activity (Owner only; null for other roles, whose role lacks `activity.view`).
 *
 * Rules (prototype unless noted):
 * - Usable licenses (KPIs, slots) = active, expiring or trial (LICENSE_STATUS_META.usable).
 * - Upcoming renewals = active or expiring licenses (not trials) ending within 365 days; "soon" below 60 days.
 * - Spend uses order snapshots: PAID orders count in full, PARTIALLY_REFUNDED ones net of processed refunds (allocated
 *   to their lines by largest remainder), REFUNDED and unpaid orders not at all. Amounts include GST. KPI windows use
 *   Order.paidAt: last 365 days, this Indian financial year (from 1 April IST), all time.
 * - Alerts: a license ending within 60 days; (new) a license that ended within the last 30 days; (new) a one-time
 *   license whose updates ended before a newer stable release; a ticket waiting for the customer; a usable license
 *   with every device slot taken. One alert per kind, naming the most urgent case; `more` counts the others.
 */
import "server-only";
import { LicenseStatus, OrderStatus, PlanType, TicketStatus, type Prisma, type TeamRole } from "@/generated/prisma/client";
import { DAY_MS, daysUntil, fiscalYearLabel, formatDateIST, fromIstParts, istParts, MONTHS_SHORT } from "@/lib/dates";
import type { Db } from "@/lib/db";
import { countActiveDevicesForAccount } from "@/lib/licensing/device-limit";
import { renewalOptionsFor, type RenewalOption, type RenewalPlan } from "@/lib/licensing/account";
import { compareVersions, STABLE_CHANNEL } from "@/lib/licensing/entitlement";
import { deriveLicenseStatus, EXPIRING_DAYS, LICENSE_STATUS_META, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { retentionCutoff } from "@/lib/portal/activity";
import { teamCan } from "@/lib/rbac";
import type { Tone } from "@/lib/design/tokens";

export const RENEWAL_WINDOW_DAYS = 365;
/** New: expired licenses keep an alert for this many days after their end date. */
export const EXPIRED_ALERT_DAYS = 30;
export const UTILIZATION_LIMIT = 20;
export const RENEWALS_LIMIT = 20;
export const RECENT_ACTIVITY_LIMIT = 6;
/** Licenses read for the Overview; accounts above this see the first ones by id (decisions.md scale notes). */
export const OVERVIEW_LICENSE_LIMIT = 5000;
const PARTIAL_REFUND_ORDERS_LIMIT = 1000;

export type OverviewAlertKind = "expiring" | "expired" | "updates_ended" | "ticket_waiting" | "device_limit";

export type OverviewAlert = {
  kind: OverviewAlertKind;
  tone: Tone;
  /** Material Symbols name. */
  icon: "event_upcoming" | "event_busy" | "new_releases" | "mark_chat_unread" | "devices";
  title: string;
  body: string;
  cta: {
    label: string;
    /** Where the CTA goes without the cart (license page tab, ticket, product plans). */
    href: string;
    /**
     * Cart line for "Renew now" / "Renew maintenance" (members with `purchases` add it to the cart and open /cart;
     * others follow `href`). Null when the CTA is not a purchase.
     */
    renewal: RenewalOption | null;
  };
  licenseId: string | null;
  ticketId: string | null;
  /** Other licenses (or tickets) in the same state, beyond the one named. */
  more: number;
};

export type OverviewKpis = {
  /** "ACTIVE LICENSES": "{active} of {total}", "{inactive} expired or revoked". */
  licenses: { active: number; total: number; inactive: number };
  /** "DEVICE SLOTS": "{used} / {slots}", "{pct}% in use across {licenses} licenses" or "No active slots". */
  deviceSlots: { used: number; slots: number; pct: number | null; licenses: number };
  /** "SPEND · 12 MONTHS" (incl. GST): last 365 days, this FY ("26-27") and all time. */
  spend: { last12MonthsPaise: number; thisFyPaise: number; allTimePaise: number; fyLabel: string };
  /** "NEXT RENEWAL": "{days} days", "{short} · {date}", or null ("—" / "Nothing due"). */
  nextRenewal: { licenseId: string; productShortName: string; expiresAt: string; days: number } | null;
};

export type UtilizationRow = { licenseId: string; productShortName: string; used: number; limit: number; full: boolean };

export type RenewalTimeline = {
  /** Twelve IST months from the current one ("Oct", "Nov", ...). */
  months: Array<{ key: string; label: string }>;
  items: Array<{
    licenseId: string;
    productShortName: string;
    planName: string;
    expiresAt: string;
    days: number;
    /** Ends within 60 days (peach in the prototype). */
    soon: boolean;
    /** Dot position on the 12-month track, 2-98 (%). */
    positionPct: number;
    /** The renewal cart line and price ("₹x + GST"), or null when the license cannot be renewed here. */
    renewal: RenewalOption | null;
  }>;
  /** Upcoming renewals beyond RENEWALS_LIMIT. */
  more: number;
};

export type SpendByProductRow = {
  productId: string;
  productName: string;
  productShortName: string;
  tone: string;
  amountPaise: number;
  /** Bar width in % of the largest product (at least 4). */
  barPct: number;
};

export type RecentActivityRow = { id: string; at: string; actorName: string; action: string; target: string; kind: string };

export type AccountOverview = {
  account: { id: string; legalName: string };
  alerts: OverviewAlert[];
  kpis: OverviewKpis;
  utilization: { rows: UtilizationRow[]; more: number };
  renewals: RenewalTimeline;
  spendByProduct: SpendByProductRow[];
  /** Owner only (team permission `activity.view`); null for other roles. */
  recentActivity: RecentActivityRow[] | null;
  generatedAt: string;
};

// ---------- Pure helpers ----------

/** "1 day", "12 days". */
export function daysText(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** Start of the current Indian financial year: 1 April, 00:00 IST. */
export function financialYearStart(now: Date): Date {
  const p = istParts(now);
  return fromIstParts({ year: p.month >= 4 ? p.year : p.year - 1, month: 4, day: 1 });
}

/** Start of the current IST calendar month. */
export function istMonthStart(now: Date): Date {
  const p = istParts(now);
  return fromIstParts({ year: p.year, month: p.month, day: 1 });
}

/** Twelve IST months starting with the current one: [{ key: "2026-10", label: "Oct" }, ...]. */
export function renewalMonths(now: Date): RenewalTimeline["months"] {
  const p = istParts(now);
  return Array.from({ length: 12 }, (_, i) => {
    const index = p.month - 1 + i;
    const year = p.year + Math.floor(index / 12);
    const month = (index % 12) + 1;
    return { key: `${year}-${String(month).padStart(2, "0")}`, label: MONTHS_SHORT[month - 1] ?? "" };
  });
}

/** Dot position on the 12-month track: (end - start of this IST month) / 365 days, clamped to 2-98 (%), 0.1 precision. */
export function timelinePosition(expiresAt: Date, now: Date): number {
  const pct = ((expiresAt.getTime() - istMonthStart(now).getTime()) / (RENEWAL_WINDOW_DAYS * DAY_MS)) * 100;
  return Math.round(Math.min(98, Math.max(2, pct)) * 10) / 10;
}

/**
 * Net amount of each line after `refundedPaise` is taken from the whole order, split in proportion to the lines'
 * gross amounts by largest remainder (exact integer paise; the parts always add up to the refund).
 */
export function netLineAmounts(grossPaise: readonly number[], refundedPaise: number): number[] {
  const total = grossPaise.reduce((sum, g) => sum + Math.max(0, g), 0);
  if (total <= 0) return grossPaise.map(() => 0);
  const refund = BigInt(Math.min(Math.max(0, Math.trunc(refundedPaise)), total));
  const bigTotal = BigInt(total);
  const shares = grossPaise.map((g) => (refund * BigInt(Math.max(0, g))) / bigTotal);
  const remainders = grossPaise.map((g, i) => ({ i, rem: (refund * BigInt(Math.max(0, g))) % bigTotal }));
  let left = refund - shares.reduce((sum, s) => sum + s, BigInt(0));
  remainders.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of remainders) {
    if (left <= BigInt(0)) break;
    shares[i] = (shares[i] ?? BigInt(0)) + BigInt(1);
    left -= BigInt(1);
  }
  return grossPaise.map((g, i) => Math.max(0, g) - Number(shares[i] ?? BigInt(0)));
}

/** Bars of "Spend by product": largest first, width relative to the largest (minimum 4%, prototype). */
export function spendBars<T extends { amountPaise: number }>(rows: readonly T[]): Array<T & { barPct: number }> {
  const positive = rows.filter((r) => r.amountPaise > 0).sort((a, b) => b.amountPaise - a.amountPaise);
  const max = Math.max(1, ...positive.map((r) => r.amountPaise));
  return positive.map((r) => ({ ...r, barPct: Math.round(Math.max(4, (r.amountPaise / max) * 100) * 10) / 10 }));
}

/** The renewal card a license offers on the Overview: renewal, maintenance, or a trial's conversion. */
export function primaryRenewal(options: readonly RenewalOption[]): RenewalOption | null {
  return options.find((o) => o.tag === "RENEWAL" || o.tag === "MAINTENANCE" || o.tag === "BUY") ?? null;
}

const licenseHref = (id: string, tab?: string) => `/account/licenses/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ""}`;

export type AlertLicense = {
  id: string;
  productId: string;
  productShortName: string;
  isTrial: boolean;
  expiresAt: Date | null;
  updatesUntil: Date;
  renewal: RenewalOption | null;
};

export function expiringAlert(license: AlertLicense & { expiresAt: Date }, more: number, now: Date): OverviewAlert {
  return {
    kind: "expiring",
    tone: "peach",
    icon: "event_upcoming",
    title: `${license.productShortName} ends in ${daysText(daysUntil(license.expiresAt, now))}.`,
    body: `Renew ${license.id} to keep billing without interruption.`,
    cta: { label: "Renew now", href: licenseHref(license.id, "renew"), renewal: license.renewal },
    licenseId: license.id,
    ticketId: null,
    more,
  };
}

/** New copy, from the license page's "License expired" / "Trial ended" explanations. */
export function expiredAlert(license: AlertLicense & { expiresAt: Date }, more: number): OverviewAlert {
  const date = formatDateIST(license.expiresAt);
  return license.isTrial
    ? {
        kind: "expired",
        tone: "peach",
        icon: "event_busy",
        title: `Your ${license.productShortName} trial ended on ${date}.`,
        body: `Buy a license to continue where you left off. ${license.id} keeps the same key and data.`,
        cta: { label: "Buy a license", href: `/software/${encodeURIComponent(license.productId)}#plans`, renewal: license.renewal },
        licenseId: license.id,
        ticketId: null,
        more,
      }
    : {
        kind: "expired",
        tone: "peach",
        icon: "event_busy",
        title: `${license.productShortName} ended on ${date}.`,
        body: `Renew ${license.id} to continue where you left off. Your data is safe.`,
        cta: { label: "Renew now", href: licenseHref(license.id, "renew"), renewal: license.renewal },
        licenseId: license.id,
        ticketId: null,
        more,
      };
}

/** New copy: a one-time license whose updates period ended before a newer release came out. */
export function updatesEndedAlert(license: AlertLicense, version: string, more: number): OverviewAlert {
  return {
    kind: "updates_ended",
    tone: "lavender",
    icon: "new_releases",
    title: `Updates for ${license.productShortName} ended on ${formatDateIST(license.updatesUntil)}.`,
    body: `Version ${version} is out. Renew maintenance for ${license.id} to download it.`,
    cta: { label: "Renew maintenance", href: licenseHref(license.id, "renew"), renewal: license.renewal },
    licenseId: license.id,
    ticketId: null,
    more,
  };
}

export function ticketWaitingAlert(ticket: { id: string; subject: string }, more: number): OverviewAlert {
  return {
    kind: "ticket_waiting",
    tone: "blue",
    icon: "mark_chat_unread",
    title: "Support is waiting for your reply.",
    body: `${ticket.id} \u00b7 ${ticket.subject}`,
    cta: { label: "Open ticket", href: `/account/tickets/${encodeURIComponent(ticket.id)}`, renewal: null },
    licenseId: null,
    ticketId: ticket.id,
    more,
  };
}

export function deviceLimitAlert(licenseId: string, more: number): OverviewAlert {
  return {
    kind: "device_limit",
    tone: "lavender",
    icon: "devices",
    title: `${licenseId} has no free device slots.`,
    body: "Deactivate a computer or add one before installing on a new PC.",
    cta: { label: "Manage devices", href: licenseHref(licenseId, "devices"), renewal: null },
    licenseId,
    ticketId: null,
    more,
  };
}

// ---------- Loader ----------

const PLAN_FIELDS = {
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

const OVERVIEW_LICENSE_SELECT = {
  id: true,
  status: true,
  expiresAt: true,
  updatesUntil: true,
  deviceLimit: true,
  productId: true,
  product: { select: { id: true, name: true, shortName: true, status: true } },
  plan: { select: PLAN_FIELDS },
} as const satisfies Prisma.LicenseSelect;

type OverviewLicenseRecord = Prisma.LicenseGetPayload<{ select: typeof OVERVIEW_LICENSE_SELECT }>;
type OverviewLicense = OverviewLicenseRecord & { derived: DerivedLicenseStatus; usable: boolean; activeDevices: number };

export type OverviewScope = { accountId: string; legalName: string; role: TeamRole };

type SpendTotals = { kpi: OverviewKpis["spend"]; byProduct: Map<string, number> };

/** Spend from order snapshots (see the module comment). */
export async function accountSpend(client: Db, accountId: string, now: Date): Promise<SpendTotals> {
  const since12 = new Date(now.getTime() - RENEWAL_WINDOW_DAYS * DAY_MS);
  const fyStart = financialYearStart(now);
  const paid: Prisma.OrderWhereInput = { accountId, status: OrderStatus.PAID };
  const sum = async (where: Prisma.OrderWhereInput) =>
    (await client.order.aggregate({ where, _sum: { totalPaise: true } }))._sum.totalPaise ?? 0;
  let allTimePaise = await sum(paid);
  let last12MonthsPaise = await sum({ ...paid, paidAt: { gt: since12 } });
  let thisFyPaise = await sum({ ...paid, paidAt: { gte: fyStart } });

  const byProduct = new Map<string, number>();
  const add = (productId: string, paise: number) => byProduct.set(productId, (byProduct.get(productId) ?? 0) + paise);
  const lineSums = await client.orderItem.groupBy({
    by: ["planId"],
    where: { order: paid },
    _sum: { taxablePaise: true, taxPaise: true },
  });
  const planProducts = new Map(
    (
      await client.plan.findMany({ where: { id: { in: lineSums.map((l) => l.planId) } }, select: { id: true, productId: true } })
    ).map((p) => [p.id, p.productId]),
  );
  for (const line of lineSums) {
    const productId = planProducts.get(line.planId);
    if (productId) add(productId, (line._sum.taxablePaise ?? 0) + (line._sum.taxPaise ?? 0));
  }

  // Partly refunded orders: rare, so they are read one by one and netted in code.
  const partial = await client.order.findMany({
    where: { accountId, status: OrderStatus.PARTIALLY_REFUNDED },
    orderBy: { id: "asc" },
    take: PARTIAL_REFUND_ORDERS_LIMIT,
    select: {
      paidAt: true,
      totalPaise: true,
      items: { orderBy: { id: "asc" }, select: { taxablePaise: true, taxPaise: true, plan: { select: { productId: true } } } },
      payments: { select: { refunds: { where: { status: "PROCESSED" }, select: { amountPaise: true } } } },
    },
  });
  for (const order of partial) {
    const refunded = order.payments.reduce((s, p) => s + p.refunds.reduce((r, x) => r + x.amountPaise, 0), 0);
    const net = Math.max(0, order.totalPaise - refunded);
    allTimePaise += net;
    if (order.paidAt && order.paidAt.getTime() > since12.getTime()) last12MonthsPaise += net;
    if (order.paidAt && order.paidAt.getTime() >= fyStart.getTime()) thisFyPaise += net;
    const lines = netLineAmounts(order.items.map((i) => i.taxablePaise + i.taxPaise), refunded);
    order.items.forEach((item, i) => add(item.plan.productId, lines[i] ?? 0));
  }
  return { kpi: { last12MonthsPaise, thisFyPaise, allTimePaise, fyLabel: fiscalYearLabel(now) }, byProduct };
}

/** The newest stable release (by version) of each product released after `after`, for one-time licenses. */
async function newerReleases(client: Db, licenses: readonly OverviewLicense[], now: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (licenses.length === 0) return out;
  const releases = await client.release.findMany({
    where: {
      productId: { in: [...new Set(licenses.map((l) => l.productId))] },
      status: "PUBLISHED",
      channel: STABLE_CHANNEL,
      releasedAt: { lte: now },
    },
    orderBy: [{ releasedAt: "desc" }, { id: "asc" }],
    take: 2000,
    select: { productId: true, version: true, releasedAt: true },
  });
  for (const license of licenses) {
    let best: string | null = null;
    for (const r of releases) {
      if (r.productId !== license.productId || !r.releasedAt || r.releasedAt.getTime() <= license.updatesUntil.getTime()) continue;
      if (best === null || compareVersions(r.version, best) > 0) best = r.version;
    }
    if (best !== null) out.set(license.id, best);
  }
  return out;
}

/** GET /api/account/overview for the caller's active account (scope from the server-side session). */
export async function getAccountOverview(client: Db, scope: OverviewScope, now: Date = new Date()): Promise<AccountOverview> {
  const { accountId } = scope;
  const records = await client.license.findMany({
    where: { accountId },
    orderBy: { id: "asc" },
    take: OVERVIEW_LICENSE_LIMIT,
    select: OVERVIEW_LICENSE_SELECT,
  });
  const total = records.length < OVERVIEW_LICENSE_LIMIT ? records.length : await client.license.count({ where: { accountId } });
  const active = await countActiveDevicesForAccount(client, accountId);
  const licenses: OverviewLicense[] = records.map((r) => {
    const derived = deriveLicenseStatus(r, now);
    return { ...r, derived, usable: LICENSE_STATUS_META[derived].usable, activeDevices: active.get(r.id) ?? 0 };
  });
  const usable = licenses.filter((l) => l.usable);
  const usableProducts = new Set(usable.map((l) => l.productId));
  const windowEnd = now.getTime() + RENEWAL_WINDOW_DAYS * DAY_MS;

  const upcoming = licenses
    .filter((l): l is OverviewLicense & { expiresAt: Date } =>
      (l.derived === "active" || l.derived === "expiring") && l.expiresAt !== null && l.expiresAt.getTime() < windowEnd,
    )
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || (a.id < b.id ? -1 : 1));
  const soon = upcoming.filter((l) => l.expiresAt.getTime() - now.getTime() < EXPIRING_DAYS * DAY_MS);
  const recentlyExpired = licenses
    .filter((l): l is OverviewLicense & { expiresAt: Date } =>
      l.derived === "expired" &&
      l.expiresAt !== null &&
      now.getTime() - l.expiresAt.getTime() <= EXPIRED_ALERT_DAYS * DAY_MS &&
      // Already replaced by another working license of the product: nothing to act on.
      !usableProducts.has(l.productId),
    )
    .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime() || (a.id < b.id ? -1 : 1));
  const updatesOver = licenses.filter(
    (l) => l.usable && l.status === LicenseStatus.ACTIVE && l.expiresAt === null && l.updatesUntil.getTime() <= now.getTime(),
  );
  const newer = await newerReleases(client, updatesOver, now);
  const updatesEnded = updatesOver
    .filter((l) => newer.has(l.id))
    .sort((a, b) => b.updatesUntil.getTime() - a.updatesUntil.getTime() || (a.id < b.id ? -1 : 1));
  const full = usable.filter((l) => l.activeDevices >= l.deviceLimit);

  // Renewal offers need the products' plans (maintenance, the trial's starting plan).
  const listed = upcoming.slice(0, RENEWALS_LIMIT);
  const needsOffer = [...listed, ...recentlyExpired.slice(0, 1), ...updatesEnded.slice(0, 1)];
  const plans = needsOffer.length
    ? await client.plan.findMany({
        where: { productId: { in: [...new Set(needsOffer.map((l) => l.productId))] } },
        select: { ...PLAN_FIELDS, productId: true },
      })
    : [];
  const plansByProduct = new Map<string, RenewalPlan[]>();
  for (const plan of plans) plansByProduct.set(plan.productId, [...(plansByProduct.get(plan.productId) ?? []), plan]);
  const renewalFor = (l: OverviewLicense): RenewalOption | null =>
    primaryRenewal(
      renewalOptionsFor(
        {
          status: l.status,
          expiresAt: l.expiresAt,
          updatesUntil: l.updatesUntil,
          deviceLimit: l.deviceLimit,
          plan: l.plan,
          productStatus: l.product.status,
        },
        plansByProduct.get(l.productId) ?? [],
        now,
      ),
    );
  const alertLicense = (l: OverviewLicense): AlertLicense => ({
    id: l.id,
    productId: l.productId,
    productShortName: l.product.shortName,
    isTrial: l.status === LicenseStatus.TRIAL || l.plan.type === PlanType.TRIAL,
    expiresAt: l.expiresAt,
    updatesUntil: l.updatesUntil,
    renewal: renewalFor(l),
  });

  const alerts: OverviewAlert[] = [];
  const firstSoon = soon[0];
  if (firstSoon) alerts.push(expiringAlert({ ...alertLicense(firstSoon), expiresAt: firstSoon.expiresAt }, soon.length - 1, now));
  const firstExpired = recentlyExpired[0];
  if (firstExpired) {
    alerts.push(expiredAlert({ ...alertLicense(firstExpired), expiresAt: firstExpired.expiresAt }, recentlyExpired.length - 1));
  }
  const firstUpdates = updatesEnded[0];
  if (firstUpdates) {
    alerts.push(updatesEndedAlert(alertLicense(firstUpdates), newer.get(firstUpdates.id) ?? "", updatesEnded.length - 1));
  }
  const waiting = await client.supportTicket.findMany({
    where: { accountId, status: TicketStatus.AWAITING_CUSTOMER },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { id: true, subject: true },
  });
  const firstWaiting = waiting[0];
  if (firstWaiting) {
    const count = await client.supportTicket.count({ where: { accountId, status: TicketStatus.AWAITING_CUSTOMER } });
    alerts.push(ticketWaitingAlert(firstWaiting, count - 1));
  }
  const firstFull = full[0];
  if (firstFull) alerts.push(deviceLimitAlert(firstFull.id, full.length - 1));

  const used = usable.reduce((n, l) => n + l.activeDevices, 0);
  const slots = usable.reduce((n, l) => n + l.deviceLimit, 0);
  const next = upcoming[0];
  const spend = await accountSpend(client, accountId, now);
  const ratio = (l: OverviewLicense) => (l.deviceLimit > 0 ? l.activeDevices / l.deviceLimit : 0);
  const utilization = [...usable]
    .sort((a, b) => ratio(b) - ratio(a) || (a.id < b.id ? -1 : 1))
    .map((l) => ({
      licenseId: l.id,
      productShortName: l.product.shortName,
      used: l.activeDevices,
      limit: l.deviceLimit,
      full: l.activeDevices >= l.deviceLimit,
    }));

  const spendProducts = spend.byProduct.size
    ? await client.product.findMany({
        where: { id: { in: [...spend.byProduct.keys()] } },
        select: { id: true, name: true, shortName: true, tone: true, category: { select: { tone: true } } },
      })
    : [];
  const spendByProduct = spendBars(
    spendProducts.map((p) => ({
      productId: p.id,
      productName: p.name,
      productShortName: p.shortName,
      tone: p.tone ?? p.category.tone,
      amountPaise: spend.byProduct.get(p.id) ?? 0,
    })),
  );

  const recentActivity = teamCan(scope.role, "activity.view")
    ? (
        await client.accountActivity.findMany({
          where: { accountId, createdAt: { gte: retentionCutoff(now) } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: RECENT_ACTIVITY_LIMIT,
          select: { id: true, createdAt: true, actorName: true, action: true, target: true, kind: true },
        })
      ).map((a) => ({ id: a.id, at: a.createdAt.toISOString(), actorName: a.actorName, action: a.action, target: a.target, kind: a.kind }))
    : null;

  return {
    account: { id: accountId, legalName: scope.legalName },
    alerts,
    kpis: {
      licenses: { active: usable.length, total, inactive: Math.max(0, total - usable.length) },
      deviceSlots: { used, slots, pct: slots > 0 ? Math.round((used / slots) * 100) : null, licenses: usable.length },
      spend: spend.kpi,
      nextRenewal: next
        ? {
            licenseId: next.id,
            productShortName: next.product.shortName,
            expiresAt: next.expiresAt.toISOString(),
            days: daysUntil(next.expiresAt, now),
          }
        : null,
    },
    utilization: { rows: utilization.slice(0, UTILIZATION_LIMIT), more: Math.max(0, utilization.length - UTILIZATION_LIMIT) },
    renewals: {
      months: renewalMonths(now),
      items: listed.map((l) => ({
        licenseId: l.id,
        productShortName: l.product.shortName,
        planName: l.plan.name,
        expiresAt: l.expiresAt.toISOString(),
        days: daysUntil(l.expiresAt, now),
        soon: l.expiresAt.getTime() - now.getTime() < EXPIRING_DAYS * DAY_MS,
        positionPct: timelinePosition(l.expiresAt, now),
        renewal: renewalFor(l),
      })),
      more: Math.max(0, upcoming.length - RENEWALS_LIMIT),
    },
    spendByProduct,
    recentActivity,
    generatedAt: now.toISOString(),
  };
}
