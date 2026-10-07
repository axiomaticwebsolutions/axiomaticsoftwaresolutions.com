/**
 * Admin Overview data (GET /api/admin/overview and the /admin page; Admin Console.dc.html `overview()`).
 * Rules (prototype unless noted):
 * - REVENUE and PAID ORDERS: orders paid in the range (Order.paidAt), PAID in full and PARTLY REFUNDED net of their
 *   processed refunds (taxable share), REFUNDED not at all; taxable value, excluding GST. The delta compares the
 *   previous period of the same length (lib/admin/overview/range.ts).
 * - NEEDS ATTENTION: all orders pending, confirming or in review (all time). ACTIVE LICENSES: derived active +
 *   expiring, with the ACTIVE licenses ending in the next 30 days. OPEN TICKETS: open or awaiting the customer.
 * - Revenue chart: the range's day / week / month buckets. Orders by payment status: orders created in the range.
 *   Webhooks: deliveries received in the range. Product performance: paid orders and line taxable value per product
 *   in the range, active licenses today. License health and support workload: today.
 * - Recent activity: the latest audit rows, only when the caller holds `audit.view`.
 */
import "server-only";
import { OrderStatus, TicketStatus } from "@/generated/prisma/client";
import { getSetting } from "@/lib/config";
import { startOfDayIST } from "@/lib/dates";
import type { Db } from "@/lib/db";
import {
  licenseHealthCounts,
  licensesEndingWithin,
  openTicketGroups,
  paidRevenueByDay,
  paidRevenueTotal,
  paidSalesByProduct,
  partialRefundAdjustments,
  workloadStaff,
} from "@/lib/admin/reports/queries";
import { STAFF_ROLE_LABELS } from "@/lib/rbac";
import {
  assigneeNames,
  EXPIRING_SOON_KPI_DAYS,
  LICENSE_HEALTH_ROWS,
  OVERVIEW_COPY,
  PAYMENT_STATUS_GROUPS,
  RECENT_ACTIVITY_LIMIT,
  relativeTime,
  auditActionText,
  toneOf,
  type OverviewActivity,
  type OverviewAssignee,
  type OverviewData,
  type OverviewProductRow,
} from "./model";
import { bucketIndex, deltaPercent, rangeTicks, rangeWindow, type RangeKey } from "./range";

export type OverviewOptions = {
  range: RangeKey;
  now: Date;
  /** The caller holds `audit.view` (recent activity is included). */
  includeActivity: boolean;
};

export async function getAdminOverview(client: Db, opts: OverviewOptions): Promise<OverviewData> {
  const { now } = opts;
  const win = rangeWindow(opts.range, now);
  const current = { from: win.from, to: win.to };
  const previous = { from: win.prevFrom, to: win.prevTo };

  const [business, days, partial, prevTotal, prevPartial, needsAttention, health, endingSoon] = await Promise.all([
    getSetting(client, "business"),
    paidRevenueByDay(client, current),
    partialRefundAdjustments(client, current),
    paidRevenueTotal(client, previous),
    partialRefundAdjustments(client, previous),
    client.order.count({ where: { status: { in: [OrderStatus.PENDING, OrderStatus.REVIEW, OrderStatus.CONFIRMING] } } }),
    licenseHealthCounts(client, now),
    licensesEndingWithin(client, now, EXPIRING_SOON_KPI_DAYS),
  ]);
  const [statusGroups, webhookGroups, productSales, products, tickets, activity] = await Promise.all([
    client.order.groupBy({ by: ["status"], where: { createdAt: { gte: win.from, lt: win.to } }, _count: { _all: true } }),
    client.webhookDelivery.groupBy({ by: ["result"], where: { receivedAt: { gte: win.from, lt: win.to } }, _count: { _all: true } }),
    paidSalesByProduct(client, current),
    client.product.findMany({
      orderBy: [{ rank: "asc" }, { id: "asc" }],
      select: { id: true, shortName: true, tone: true, status: true, category: { select: { tone: true } } },
    }),
    openTicketGroups(client),
    opts.includeActivity
      ? client.auditLog.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: RECENT_ACTIVITY_LIMIT,
          select: { id: true, action: true, target: true, actorRole: true, createdAt: true, actor: { select: { name: true } } },
        })
      : Promise.resolve(null),
  ]);

  // Revenue chart and KPIs.
  const bars = win.buckets.map((b) => ({ key: b.key, label: b.label, title: b.title, paise: 0 }));
  let orders = 0;
  for (const row of days) {
    orders += row.orders;
    const i = bucketIndex(win.buckets, startOfDayIST(row.day));
    const bar = bars[i];
    if (bar) bar.paise += row.taxablePaise;
  }
  for (const adj of partial) {
    const bar = bars[bucketIndex(win.buckets, adj.paidAt)];
    if (bar) bar.paise -= adj.taxablePaise;
  }
  const revenue = bars.reduce((s, b) => s + b.paise, 0);
  const prevRevenue = prevTotal.taxablePaise - prevPartial.reduce((s, a) => s + a.taxablePaise, 0);

  // Products.
  const refundedByProduct = new Map<string, number>();
  for (const adj of partial) for (const [id, n] of adj.byProduct) refundedByProduct.set(id, (refundedByProduct.get(id) ?? 0) + n);
  const productRows: OverviewProductRow[] = products
    .map((p) => {
      const sales = productSales.get(p.id);
      const counts = health.byProduct.get(p.id);
      return {
        id: p.id,
        name: p.shortName,
        tone: toneOf(p.tone ?? p.category.tone),
        orders: sales?.orders ?? 0,
        activeLicenses: (counts?.active ?? 0) + (counts?.expiring ?? 0),
        revenuePaise: (sales?.taxablePaise ?? 0) - (refundedByProduct.get(p.id) ?? 0),
        published: p.status === "PUBLISHED",
      };
    })
    .filter((p) => p.published || p.orders > 0 || p.activeLicenses > 0)
    .sort((a, b) => b.revenuePaise - a.revenuePaise)
    .map(({ published: _published, ...row }) => row);

  // Support.
  const support = await supportWorkload(client, tickets);
  const openCount = tickets.reduce((s, t) => s + t.count, 0);

  const statusCount = new Map(statusGroups.map((g) => [g.status, g._count._all]));
  const webhookCount = (result: string) => webhookGroups.find((g) => g.result === result)?._count._all ?? 0;

  return {
    range: opts.range,
    generatedAt: now.toISOString(),
    sample: business.sample,
    kpis: {
      revenue: { paise: revenue, previousPaise: prevRevenue, deltaPct: deltaPercent(revenue, prevRevenue) },
      paidOrders: { count: orders, previousCount: prevTotal.orders, avgPaise: orders > 0 ? Math.round(revenue / orders) : 0 },
      needsAttention,
      activeLicenses: { count: health.totals.active + health.totals.expiring, expiringSoon: endingSoon },
      openTickets: { count: openCount, high: support.highPriority, unassigned: tickets.filter((t) => t.assigneeId === null).reduce((s, t) => s + t.count, 0) },
    },
    revenue: {
      totalPaise: revenue,
      peakPaise: Math.max(0, ...bars.map((b) => b.paise)),
      unit: win.unit,
      bars,
      ticks: rangeTicks(win.buckets),
    },
    paymentStatus: PAYMENT_STATUS_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      count: g.statuses.reduce((s, st) => s + (statusCount.get(st) ?? 0), 0),
    })).filter((g) => g.count > 0),
    webhooks: { fulfilled: webhookCount("fulfilled"), duplicates: webhookCount("duplicate_ignored"), rejected: webhookCount("invalid_signature") },
    products: productRows,
    licenseHealth: LICENSE_HEALTH_ROWS.map((r) => ({ key: r.key, label: r.label, count: health.totals[r.key] })),
    support,
    recentActivity: activity ? activity.map((a) => activityRow(a, now)) : null,
  };
}

type TicketGroups = Awaited<ReturnType<typeof openTicketGroups>>;

/** Tiles and per-assignee bars: active Support and Admin staff (and anyone else holding open tickets), then Unassigned. */
async function supportWorkload(client: Db, tickets: TicketGroups): Promise<OverviewData["support"]> {
  const perAssignee = new Map<string, number>();
  let unassigned = 0;
  for (const t of tickets) {
    if (t.assigneeId === null) unassigned += t.count;
    else perAssignee.set(t.assigneeId, (perAssignee.get(t.assigneeId) ?? 0) + t.count);
  }
  const staff = await workloadStaff(client, [...perAssignee.keys()]);
  const names = assigneeNames(staff);
  const assignees: OverviewAssignee[] = staff.map((s) => ({ id: s.id, name: names.get(s.id) ?? s.name, count: perAssignee.get(s.id) ?? 0 }));
  assignees.push({ id: null, name: OVERVIEW_COPY.unassigned, count: unassigned });
  return {
    waitingOnUs: tickets.filter((t) => t.status === TicketStatus.OPEN).reduce((s, t) => s + t.count, 0),
    waitingOnCustomer: tickets.filter((t) => t.status === TicketStatus.AWAITING_CUSTOMER).reduce((s, t) => s + t.count, 0),
    highPriority: tickets.filter((t) => t.high).reduce((s, t) => s + t.count, 0),
    assignees,
  };
}

type AuditRow = { id: string; action: string; target: string; actorRole: string; createdAt: Date; actor: { name: string } | null };

const ROLE_ACTOR: Record<string, string> = {
  system: "System",
  owner: STAFF_ROLE_LABELS.OWNER,
  admin: STAFF_ROLE_LABELS.ADMIN,
  support: STAFF_ROLE_LABELS.SUPPORT,
  finance: STAFF_ROLE_LABELS.FINANCE,
};

/** "<strong>Anita Desai</strong> issued refund · AX-10288" + "3h ago" (the actor's name now; System for jobs). */
function activityRow(a: AuditRow, now: Date): OverviewActivity {
  const name = a.actor?.name.trim();
  return {
    id: a.id,
    actor: name || ROLE_ACTOR[a.actorRole] || "Staff",
    action: auditActionText(a.action),
    target: a.target,
    at: a.createdAt.toISOString(),
    when: relativeTime(a.createdAt, now),
  };
}
