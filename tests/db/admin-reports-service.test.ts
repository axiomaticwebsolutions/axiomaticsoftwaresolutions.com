/**
 * getAdminReports() and buildReportExport() against the database (decisions.md Phase 6 "Reports"): sales and GST by
 * IST month from tax invoices, credit notes kept apart with an exact tax split (a full refund reverses its invoice),
 * FAILED refunds and refunds without a credit note left out, sales by product with credit notes by line share,
 * license health per product, support flow (opened, resolved, median first response, falling back to the first
 * public staff message as on the Tickets page) and every export's shape.
 * June 2033 and the year before hold only this file's rows, so windowed figures are exact.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { User } from "@/generated/prisma/client";
import { buildReportExport } from "@/lib/admin/reports/exports";
import { REPORT_EXPORT_KEYS, type ReportsData } from "@/lib/admin/reports/model";
import { getAdminReports } from "@/lib/admin/reports/service";
import { db } from "@/lib/db";
import { makeStaff } from "../support/admin-fixtures";
import {
  addPayment,
  DAY,
  invoiceNo,
  ist,
  makeCatalog,
  makeLicense,
  makeMember,
  makeOrder,
  makeRefund,
  makeStaffTicket,
  tag,
  type Catalog,
} from "./admin-reports-fixtures";

/** 15 Jun 2033, 12:00 IST: the overview tests use 2031, so the two files never share a window. */
const NOW = new Date("2033-06-15T06:30:00.000Z");

let a: Catalog;
let b: Catalog;
let agent: User;
let accountId: string;
let year: ReportsData;
let month: ReportsData;
let baseline: ReportsData;
const invoices: Record<"o1" | "o2" | "o3", string> = { o1: invoiceNo(), o2: invoiceNo(), o3: invoiceNo() };
let licenseKey = "";
let o2Id = "";

beforeAll(async () => {
  [a, b] = [await makeCatalog(), await makeCatalog()];
  const member = await makeMember();
  accountId = member.accountId;
  agent = await makeStaff("SUPPORT", { name: `Yara${tag()} Tester` });
  baseline = await getAdminReports(db, { range: "12m", now: NOW });

  // O1: intra-state, paid 20 May 2033: taxable 6,000.00, CGST 540.00 + SGST 540.00.
  const o1 = await makeOrder({
    accountId,
    lines: [{ plan: a.annual, taxablePaise: 600_000, taxPaise: 108_000 }],
    createdAt: ist("2033-05-20"),
    invoiceNumber: invoices.o1,
    billing: { name: "Priya Sharma", business: "Sharma Medicals", state: "Maharashtra", gstin: "27ABCDE1234F1Z5" },
  });
  const p1 = await addPayment(o1.id, 708_000);
  await makeRefund(p1.id, 5_000, { status: "FAILED", createdAt: ist("2033-06-11") });
  await makeRefund(p1.id, 7_000, { creditNote: false, createdAt: ist("2033-06-11") });

  // O2: inter-state, two products, paid 2 Jun 2033, refunded in full on 10 Jun (credit note reverses the invoice).
  const o2 = await makeOrder({
    accountId,
    status: "REFUNDED",
    interState: true,
    placeOfSupply: "Karnataka",
    lines: [
      { plan: a.annual, taxablePaise: 400_000, taxPaise: 72_000 },
      { plan: b.annual, taxablePaise: 100_000, taxPaise: 18_000 },
    ],
    createdAt: ist("2033-06-02"),
    invoiceNumber: invoices.o2,
  });
  o2Id = o2.id;
  const p2 = await addPayment(o2.id, 590_000);
  await makeRefund(p2.id, 590_000, { createdAt: ist("2033-06-10") });

  // O3: partly refunded; paid 10 Apr 2033, credit note (refund still pending) on 12 Jun 2033 for half the total.
  const o3 = await makeOrder({
    accountId,
    status: "PARTIALLY_REFUNDED",
    lines: [{ plan: b.annual, taxablePaise: 200_000, taxPaise: 36_000 }],
    createdAt: ist("2033-04-10"),
    invoiceNumber: invoices.o3,
  });
  const p3 = await addPayment(o3.id, 236_000);
  await makeRefund(p3.id, 118_000, { status: "PENDING", createdAt: ist("2033-06-12") });

  // Invoiced before the 12-month window.
  await makeOrder({ accountId, lines: [{ plan: a.annual, taxablePaise: 999_900, taxPaise: 179_982 }], createdAt: ist("2031-12-01"), invoiceNumber: invoiceNo() });

  const exp = (days: number) => new Date(NOW.getTime() + days * DAY);
  licenseKey = (await makeLicense(a, { accountId, expiresAt: exp(200) })).key;
  await makeLicense(a, { accountId, expiresAt: exp(20) });
  await makeLicense(a, { accountId, status: "REVOKED", expiresAt: exp(100) });

  await makeStaffTicket(accountId, {
    status: "RESOLVED",
    assigneeId: agent.id,
    createdAt: ist("2033-06-01", 10),
    firstResponseAt: new Date(ist("2033-06-01", 10).getTime() + 30 * 60_000),
    resolvedAt: ist("2033-06-02"),
  });
  await makeStaffTicket(accountId, {
    status: "OPEN",
    priority: "HIGH",
    assigneeId: agent.id,
    createdAt: ist("2033-06-05", 10),
    firstResponseAt: new Date(ist("2033-06-05", 10).getTime() + 90 * 60_000),
  });
  // Answered before firstResponseAt was recorded: the first public staff message (2 h) is its first response; the
  // customer's message and the internal note before it do not count.
  const legacy = await makeStaffTicket(accountId, { status: "OPEN", createdAt: ist("2033-06-14", 9) });
  const at = (minutes: number) => new Date(ist("2033-06-14", 9).getTime() + minutes * 60_000);
  await db.ticketMessage.createMany({
    data: [
      { ticketId: legacy.id, authorId: member.user.id, isStaff: false, body: "Any update?", attachments: [], createdAt: at(5) },
      { ticketId: legacy.id, authorId: agent.id, isStaff: true, internal: true, body: "Checking", attachments: [], createdAt: at(10) },
      { ticketId: legacy.id, authorId: agent.id, isStaff: true, body: "Fixed", attachments: [], createdAt: at(120) },
      { ticketId: legacy.id, authorId: agent.id, isStaff: true, body: "Also", attachments: [], createdAt: at(300) },
    ],
  });

  year = await getAdminReports(db, { range: "12m", now: NOW });
  month = await getAdminReports(db, { range: "30d", now: NOW });
});

const monthRow = (d: ReportsData, key: string) => d.salesByMonth.rows.find((r) => r.key === key);

describe("sales by month", () => {
  it("lists every IST month of the range with invoices by issue date and credit notes by their own date", () => {
    expect(year.salesByMonth.rows.map((r) => r.key)).toEqual([
      "2032-07", "2032-08", "2032-09", "2032-10", "2032-11", "2032-12", "2033-01", "2033-02", "2033-03", "2033-04", "2033-05", "2033-06",
    ]);
    expect(year.salesByMonth.rows[0]?.label).toBe("Jul 2032");
    expect(monthRow(year, "2033-04")).toMatchObject({ invoices: 1, taxablePaise: 200_000, gstPaise: 36_000, creditNotes: 0, netTaxablePaise: 200_000 });
    expect(monthRow(year, "2033-05")).toMatchObject({ invoices: 1, taxablePaise: 600_000, gstPaise: 108_000, valuePaise: 708_000 });
    expect(monthRow(year, "2033-06")).toMatchObject({ invoices: 1, taxablePaise: 500_000, gstPaise: 90_000, creditNotes: 2, creditTaxablePaise: 600_000, netTaxablePaise: -100_000 });
    expect(year.salesByMonth.total).toMatchObject({ invoices: 3, taxablePaise: 1_300_000, gstPaise: 234_000, valuePaise: 1_534_000, creditNotes: 2, creditTaxablePaise: 600_000, netTaxablePaise: 700_000 });
    expect(baseline.salesByMonth.total.invoices).toBe(0);
  });

  it("labels a first month that the range cuts", () => {
    expect(month.salesByMonth.rows.map((r) => r.label)).toEqual(["May 2033 (from 17 May)", "Jun 2033"]);
    expect(month.salesByMonth.total).toMatchObject({ invoices: 2, taxablePaise: 1_100_000, creditTaxablePaise: 600_000 });
    expect(month.scope).toBe("Last 30 days (17 May \u2013 15 Jun 2033)");
  });
});

describe("GST summary by month", () => {
  it("splits invoices into CGST/SGST/IGST and keeps credit notes apart, with the net tax", () => {
    const g = year.gstByMonth;
    expect(g.invoiceTotal).toMatchObject({ count: 3, taxablePaise: 1_300_000, cgstPaise: 72_000, sgstPaise: 72_000, igstPaise: 90_000, taxPaise: 234_000, valuePaise: 1_534_000 });
    expect(g.creditNotes.map((r) => r.key)).toEqual(["2033-06"]);
    expect(g.creditTotal).toMatchObject({ count: 2, taxablePaise: 600_000, cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 90_000, taxPaise: 108_000, valuePaise: 708_000 });
    expect(g.netTaxPaise).toBe(126_000);
  });

  it("leaves out FAILED refunds and refunds without a credit note number", () => {
    expect(year.gstByMonth.creditTotal.count).toBe(2);
  });
});

describe("sales by product", () => {
  it("uses invoiced line values and splits credit notes by the refunded order's lines", () => {
    const rows = year.salesByProduct.rows.filter((r) => r.productId === a.product.id || r.productId === b.product.id);
    expect(rows).toEqual([
      { productId: a.product.id, name: a.product.shortName, tone: "sage", orders: 2, taxablePaise: 1_000_000, creditPaise: 400_000, netPaise: 600_000 },
      { productId: b.product.id, name: b.product.shortName, tone: "sage", orders: 2, taxablePaise: 300_000, creditPaise: 200_000, netPaise: 100_000 },
    ]);
    expect(year.salesByProduct.total).toMatchObject({ orders: 3, taxablePaise: 1_300_000, creditPaise: 600_000, netPaise: 700_000 });
  });

  it("counts a credit note in the range even when its invoice is older", () => {
    expect(month.salesByProduct.rows.find((r) => r.productId === b.product.id)).toMatchObject({ orders: 1, taxablePaise: 100_000, creditPaise: 200_000, netPaise: -100_000 });
  });
});

describe("license health and support", () => {
  it("counts licenses per product by derived status today", () => {
    const row = year.licenseHealth.byProduct.find((r) => r.productId === a.product.id);
    expect(row?.counts).toEqual({ active: 1, expiring: 1, trial: 0, expired: 0, suspended: 0, revoked: 1 });
    expect(row?.total).toBe(3);
    expect(year.licenseHealth.byProduct.some((r) => r.productId === b.product.id)).toBe(false);
    expect(year.licenseHealth.total - baseline.licenseHealth.total).toBe(3);
  });

  it("reports tickets opened and resolved in the range and the median first response", () => {
    expect(year.support.opened).toBe(3);
    expect(year.support.resolved).toBe(1);
    // 30 min, 90 min and the fallback ticket's 120 min (firstResponseAt null, first public staff message).
    expect(year.support.medianFirstResponseMinutes).toBe(90);
    expect(year.support.waitingOnUs - baseline.support.waitingOnUs).toBe(2);
    expect(year.support.highPriority - baseline.support.highPriority).toBe(1);
    expect(year.support.assignees.find((r) => r.id === agent.id)).toEqual({
      id: agent.id,
      name: agent.name.split(" ")[0],
      role: "Support",
      open: 1,
      awaitingCustomer: 0,
      high: 1,
      resolved: 1,
    });
    expect(year.support.assignees.at(-1)?.id).toBeNull();
  });
});

describe("exports", () => {
  it("builds every report with one value per header cell, a file name and a scope", async () => {
    for (const key of REPORT_EXPORT_KEYS) {
      const built = await buildReportExport(db, key, { range: "12m", now: NOW });
      expect(built.fileName, key).toMatch(new RegExp(`^${key}-(12m-|all-|next90-)?2033-06-15[.]csv$`));
      expect(built.header.length, key).toBeGreaterThan(1);
      for (const row of built.rows) expect(row.length, key).toBe(built.header.length);
      expect(built.scope, key).toBeTruthy();
    }
  });

  it("sales register: one row per invoice issued in the range, amounts in rupees, IST dates", async () => {
    const built = await buildReportExport(db, "sales-register", { range: "12m", now: NOW });
    expect(built.rows.map((r) => r[0])).toEqual([invoices.o3, invoices.o1, invoices.o2]);
    expect(built.rows[2]).toEqual([invoices.o2, o2Id, "2033-06-02", "Priya Sharma", "27ABCDE1234F1Z5", "Karnataka", "5000.00", "0.00", "0.00", "900.00", "5900.00", "Refunded", ""]);
    expect(built.rows[1]?.[3]).toBe("Sharma Medicals");
    expect(built.scope).toBe("Last 12 months (1 Jul 2032 \u2013 15 Jun 2033)");
  });

  it("GST by state lists invoices and credit notes per place of supply", async () => {
    const built = await buildReportExport(db, "gst-by-state", { range: "12m", now: NOW });
    expect(built.rows).toContainEqual(["Karnataka", "Tax invoices", 1, "5000.00", "0.00", "0.00", "900.00", "5900.00"]);
    expect(built.rows).toContainEqual(["Karnataka", "Credit notes", 1, "5000.00", "0.00", "0.00", "900.00", "5900.00"]);
    expect(built.rows).toContainEqual(["Maharashtra", "Tax invoices", 2, "8000.00", "720.00", "720.00", "0.00", "9440.00"]);
    expect(built.rows).toContainEqual(["Maharashtra", "Credit notes", 1, "1000.00", "90.00", "90.00", "0.00", "1180.00"]);
  });

  it("refunds list credit notes with their split; the GST by month export ends with the net row", async () => {
    const refunds = await buildReportExport(db, "refunds", { range: "12m", now: NOW });
    expect(refunds.rows.map((r) => [r[1], r[4], r.at(-1)])).toEqual([
      [o2Id, "Processed", "5900.00"],
      [expect.any(String), "Pending", "1180.00"],
    ]);
    const gst = await buildReportExport(db, "gst-by-month", { range: "12m", now: NOW });
    expect(gst.rows.at(-1)).toEqual(["Net", "Invoices less credit notes", "", "7000.00", "630.00", "630.00", "0.00", "1260.00", "8260.00"]);
  });

  it("license register masks keys; renewal forecast values the plan price", async () => {
    const register = await buildReportExport(db, "license-register", { range: "12m", now: NOW });
    const text = JSON.stringify(register.rows);
    expect(text).not.toContain(licenseKey);
    expect(text).toContain(`${a.product.code}-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-${licenseKey.slice(-4)}`);
    const forecast = await buildReportExport(db, "renewal-forecast", { range: "12m", now: NOW });
    const mine = forecast.rows.filter((r) => r[1] === a.product.shortName && r[3] !== undefined && String(r[5]).startsWith("2033-07"));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.slice(-3)).toEqual([20, "0/3", "6000.00"]);
  });

  it("support SLA has the range's tickets with response hours; limit caps the rows", async () => {
    const sla = await buildReportExport(db, "support-sla", { range: "12m", now: NOW });
    expect(sla.rows).toHaveLength(3);
    expect(sla.rows[0]?.slice(3, 9)).toEqual(["Normal", "Resolved", agent.name, "2033-06-01", "2033-06-01", "0.5"]);
    // firstResponseAt is null on the last ticket: its first public staff message is the first response.
    expect(sla.rows[2]?.slice(7, 9)).toEqual(["2033-06-14", "2.0"]);
    const capped = await buildReportExport(db, "support-sla", { range: "12m", now: NOW, limit: 2 });
    expect(capped.rows).toHaveLength(2);
  });
});
