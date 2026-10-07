/**
 * getAdminOverview() against the database (Admin Console.dc.html overview(), decisions.md Phase 6): revenue and paid
 * orders by paidAt with partial refunds netted and refunded orders left out, the previous-period delta, revenue
 * buckets, orders by payment status, webhook results, product performance, license health, support workload and the
 * recent activity gate. Windowed figures are exact (June 2031 holds only this file's rows); all-time figures are
 * compared with a baseline taken before the rows exist.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { User } from "@/generated/prisma/client";
import type { OverviewData } from "@/lib/admin/overview/model";
import { getAdminOverview } from "@/lib/admin/overview/service";
import { db } from "@/lib/db";
import { makeStaff } from "../support/admin-fixtures";
import {
  addPayment,
  DAY,
  daysBefore,
  makeCatalog,
  makeDelivery,
  makeLicense,
  makeMember,
  makeOrder,
  makeRefund,
  makeStaffTicket,
  NOW,
  tag,
  type Catalog,
} from "./admin-reports-fixtures";

let catalog: Catalog;
let agent: User;
let before: OverviewData;
let after: OverviewData;
let afterNoAudit: OverviewData;
let previousOnly: OverviewData;
const auditTarget = `AX-OV${tag()}`;

const line = (c: Catalog, taxablePaise: number) => ({ plan: c.annual, taxablePaise, taxPaise: Math.round(taxablePaise * 0.18) });

beforeAll(async () => {
  catalog = await makeCatalog();
  const member = await makeMember();
  agent = await makeStaff("SUPPORT", { name: `Zed${tag()} Tester` });
  before = await getAdminOverview(db, { range: "30d", now: NOW, includeActivity: true });

  // Paid in the window (2 days ago) and in the previous window (40 days ago).
  await makeOrder({ accountId: member.accountId, lines: [line(catalog, 500_000)], createdAt: daysBefore(2) });
  await makeOrder({ accountId: member.accountId, lines: [line(catalog, 250_000)], createdAt: daysBefore(40) });
  // Partly refunded: half of 2,36,000 paise refunded and processed -> 1,00,000 paise of taxable value comes off.
  const partial = await makeOrder({ accountId: member.accountId, status: "PARTIALLY_REFUNDED", lines: [{ plan: catalog.annual, taxablePaise: 200_000, taxPaise: 36_000 }], createdAt: daysBefore(5) });
  const payment = await addPayment(partial.id, 236_000);
  await makeRefund(payment.id, 118_000, { createdAt: daysBefore(4) });
  // Refunded in full: no revenue, but an order created in the window.
  await makeOrder({ accountId: member.accountId, status: "REFUNDED", lines: [line(catalog, 300_000)], createdAt: daysBefore(3) });
  for (const status of ["FAILED", "PENDING", "CANCELED"] as const) {
    await makeOrder({ accountId: member.accountId, status, lines: [line(catalog, 100_000)], createdAt: daysBefore(1), paidAt: null });
  }
  // Created before the window: not in the payment status bar.
  await makeOrder({ accountId: member.accountId, status: "AWAITING_PAYMENT", lines: [line(catalog, 100_000)], createdAt: daysBefore(60), paidAt: null });

  await makeDelivery("fulfilled", daysBefore(1));
  await makeDelivery("fulfilled", daysBefore(2));
  await makeDelivery("duplicate_ignored", daysBefore(1));
  await makeDelivery("invalid_signature", daysBefore(1));
  await makeDelivery("fulfilled", daysBefore(45));

  const exp = (days: number) => new Date(NOW.getTime() + days * DAY);
  await makeLicense(catalog, { accountId: member.accountId, expiresAt: exp(200) });
  await makeLicense(catalog, { accountId: member.accountId, plan: catalog.oneTime, expiresAt: null, updatesUntil: exp(100) });
  await makeLicense(catalog, { accountId: member.accountId, expiresAt: exp(10) });
  await makeLicense(catalog, { accountId: member.accountId, expiresAt: exp(-1) });
  await makeLicense(catalog, { accountId: member.accountId, plan: catalog.trial, status: "TRIAL", expiresAt: exp(5) });
  await makeLicense(catalog, { accountId: member.accountId, status: "SUSPENDED", expiresAt: exp(90) });
  await makeLicense(catalog, { accountId: member.accountId, status: "REVOKED", expiresAt: exp(90) });

  await makeStaffTicket(member.accountId, { status: "OPEN", priority: "HIGH" });
  await makeStaffTicket(member.accountId, { status: "AWAITING_CUSTOMER", assigneeId: agent.id });
  await makeStaffTicket(member.accountId, { status: "RESOLVED", assigneeId: agent.id, resolvedAt: daysBefore(1) });

  await db.auditLog.create({
    data: { actorId: agent.id, actorRole: "support", action: "Issued refund", target: auditTarget, createdAt: new Date(NOW.getTime() - 60_000) },
  });

  after = await getAdminOverview(db, { range: "30d", now: NOW, includeActivity: true });
  afterNoAudit = await getAdminOverview(db, { range: "30d", now: NOW, includeActivity: false });
  previousOnly = await getAdminOverview(db, { range: "7d", now: new Date(NOW.getTime() - 35 * DAY), includeActivity: false });
});

const statusCount = (d: OverviewData, key: string) => d.paymentStatus.find((s) => s.key === key)?.count ?? 0;
const health = (d: OverviewData, key: string) => d.licenseHealth.find((r) => r.key === key)?.count ?? 0;

describe("KPIs", () => {
  it("revenue: taxable value of orders paid in the range, partial refunds netted, refunded orders left out", () => {
    expect(before.kpis.revenue.paise).toBe(0);
    expect(after.kpis.revenue.paise).toBe(600_000);
    expect(after.kpis.revenue.previousPaise).toBe(250_000);
    expect(after.kpis.revenue.deltaPct).toBe(140);
  });

  it("paid orders and the average order value", () => {
    expect(after.kpis.paidOrders.count).toBe(2);
    expect(after.kpis.paidOrders.previousCount).toBe(1);
    expect(after.kpis.paidOrders.avgPaise).toBe(300_000);
  });

  it("no previous revenue gives no percentage", () => {
    expect(previousOnly.kpis.revenue.paise).toBe(250_000);
    expect(previousOnly.kpis.revenue.deltaPct).toBeNull();
  });

  it("needs attention counts pending, confirming and review orders of all time", () => {
    expect(after.kpis.needsAttention - before.kpis.needsAttention).toBe(1);
  });

  it("active licenses are active plus expiring; the sub line counts active licenses ending within 30 days", () => {
    expect(after.kpis.activeLicenses.count - before.kpis.activeLicenses.count).toBe(3);
    expect(after.kpis.activeLicenses.expiringSoon - before.kpis.activeLicenses.expiringSoon).toBe(1);
  });

  it("open tickets with high priority and unassigned counts", () => {
    expect(after.kpis.openTickets.count - before.kpis.openTickets.count).toBe(2);
    expect(after.kpis.openTickets.high - before.kpis.openTickets.high).toBe(1);
    expect(after.kpis.openTickets.unassigned - before.kpis.openTickets.unassigned).toBe(1);
  });
});

describe("revenue chart", () => {
  it("has one bar per IST day for 30 days, summing to the revenue, ending today", () => {
    expect(after.revenue.unit).toBe("day");
    expect(after.revenue.bars).toHaveLength(30);
    expect(after.revenue.bars.at(-1)?.key).toBe("2031-06-15");
    expect(after.revenue.bars.reduce((s, b) => s + b.paise, 0)).toBe(after.revenue.totalPaise);
    expect(after.revenue.bars.find((b) => b.key === "2031-06-13")?.paise).toBe(500_000);
    expect(after.revenue.bars.find((b) => b.key === "2031-06-10")?.paise).toBe(100_000);
    expect(after.revenue.peakPaise).toBe(500_000);
    expect(after.revenue.ticks.at(-1)).toBe("Today");
  });

  it("uses 13 weekly buckets for 90 days and 12 months for 12 months", async () => {
    const q = await getAdminOverview(db, { range: "90d", now: NOW, includeActivity: false });
    expect(q.revenue.unit).toBe("week");
    expect(q.revenue.bars).toHaveLength(13);
    expect(q.revenue.totalPaise).toBe(850_000);
    const y = await getAdminOverview(db, { range: "12m", now: NOW, includeActivity: false });
    expect(y.revenue.unit).toBe("month");
    expect(y.revenue.bars.map((b) => b.key)).toEqual([
      "2030-07", "2030-08", "2030-09", "2030-10", "2030-11", "2030-12", "2031-01", "2031-02", "2031-03", "2031-04", "2031-05", "2031-06",
    ]);
    expect(y.revenue.bars.find((b) => b.key === "2031-05")?.paise).toBe(250_000);
    expect(y.revenue.bars.find((b) => b.key === "2031-06")?.paise).toBe(600_000);
  });
});

describe("payments and webhooks", () => {
  it("counts orders created in the range by payment status; empty groups are left out", () => {
    expect(statusCount(after, "paid")).toBe(1);
    expect(statusCount(after, "pending")).toBe(1);
    expect(statusCount(after, "failed")).toBe(1);
    expect(statusCount(after, "refunded")).toBe(2);
    expect(statusCount(after, "canceled")).toBe(1);
    expect(before.paymentStatus).toEqual([]);
    expect(after.paymentStatus.map((s) => s.key)).toEqual(["paid", "pending", "failed", "refunded", "canceled"]);
  });

  it("counts webhook deliveries received in the range by result", () => {
    expect(after.webhooks).toEqual({ fulfilled: 2, duplicates: 1, rejected: 1 });
  });
});

describe("products, licenses and support", () => {
  it("product performance: paid orders, active licenses today and net revenue", () => {
    const row = after.products.find((p) => p.id === catalog.product.id);
    expect(row).toMatchObject({ orders: 2, activeLicenses: 3, revenuePaise: 600_000, tone: "sage" });
    const revenues = after.products.map((p) => p.revenuePaise);
    expect([...revenues].sort((a, b) => b - a)).toEqual(revenues);
  });

  it("license health by derived status (prototype order)", () => {
    expect(after.licenseHealth.map((r) => r.key)).toEqual(["active", "expiring", "trial", "expired", "suspended", "revoked"]);
    for (const key of ["active", "expiring", "trial", "expired", "suspended", "revoked"]) {
      expect(health(after, key) - health(before, key), key).toBe(key === "active" ? 2 : 1);
    }
  });

  it("support workload tiles and the per-assignee row", () => {
    expect(after.support.waitingOnUs - before.support.waitingOnUs).toBe(1);
    expect(after.support.waitingOnCustomer - before.support.waitingOnCustomer).toBe(1);
    expect(after.support.highPriority - before.support.highPriority).toBe(1);
    const mine = after.support.assignees.find((a) => a.id === agent.id);
    expect(mine).toEqual({ id: agent.id, name: agent.name.split(" ")[0], count: 1 });
    expect(after.support.assignees.at(-1)?.name).toBe("Unassigned");
  });
});

describe("recent activity", () => {
  it("lists the latest audit rows with the actor's name for roles with audit.view", () => {
    const first = after.recentActivity?.[0];
    expect(first).toMatchObject({ actor: agent.name, action: "issued refund", target: auditTarget, when: "1m ago" });
    expect(after.recentActivity?.length).toBeLessThanOrEqual(7);
  });

  it("is null without audit.view", () => {
    expect(afterNoAudit.recentActivity).toBeNull();
  });
});
