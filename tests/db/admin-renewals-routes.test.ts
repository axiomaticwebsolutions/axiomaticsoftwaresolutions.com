/**
 * Admin Renewals: the row set (non-revoked, non-trial licenses ending within 60 days or ended within 30), the Window
 * filter, DAYS and renewal value, and "Send reminder now" (renewals.remind): the template that fits the end date,
 * recipients (active Owners and Billing admins with renewal emails on), one reminder per license, template and day,
 * one audit row per license, and the last reminder shown on the row.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

import { NextRequest } from "next/server";
import * as remindRoute from "@/app/api/admin/renewals/remind/route";
import * as cronRoute from "@/app/api/cron/renewals/route";
import * as listRoute from "@/app/api/admin/renewals/route";
import type { AdminRenewalRow, RemindResult } from "@/lib/admin/renewals/model";
import { renewalReminderPrefix } from "@/lib/admin/renewals/model";
import { adminRenewalStats } from "@/lib/admin/renewals/queries";
import { sendScheduledRenewalReminders } from "@/lib/admin/renewals/remind";
import { db } from "@/lib/db";
import { callRoute, makeAdminCallers, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import { DAY, makeCatalog, makeLicense, makeMember, type Catalog, type Member } from "./license-actions-fixtures";

let callers: AdminCallers;
let catalog: Catalog;
let owner: Member;
let tag: string;
const L: Record<string, string> = {};

beforeAll(async () => {
  [callers, catalog] = await Promise.all([makeAdminCallers(), makeCatalog()]);
  owner = await makeMember({ name: "Meera Iyer" });
  tag = randomBytes(4).toString("hex");
  await db.businessAccount.update({ where: { id: owner.accountId }, data: { legalName: `Iyer Pharmacy ${tag}` } });
  await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Arun Iyer" });
  await makeMember({ accountId: owner.accountId, role: "VIEWER", name: "Viewer Only" });
  const optedOut = await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Opted Out" });
  await db.user.update({ where: { id: optedOut.user.id }, data: { notificationPrefs: { renewals: false } } });

  const now = Date.now();
  const make = async (name: string, opts: Partial<Parameters<typeof makeLicense>[1]>) => {
    L[name] = (await makeLicense(catalog, { accountId: owner.accountId, ...opts })).license.id;
  };
  await make("due10", { expiresAt: new Date(now + 10 * DAY + 3_600_000) });
  await make("due5", { expiresAt: new Date(now + 5 * DAY) });
  await make("lapsed", { expiresAt: new Date(now - 3 * DAY) });
  await make("due45", { expiresAt: new Date(now + 45 * DAY), deviceLimit: 4 });
  await make("old", { expiresAt: new Date(now - 40 * DAY) });
  await make("far", { expiresAt: new Date(now + 90 * DAY) });
  await make("revoked", { expiresAt: new Date(now + 10 * DAY), status: "REVOKED" });
  await make("trial", { expiresAt: new Date(now + 10 * DAY), status: "TRIAL", plan: catalog.trial });
  await make("perpetual", { expiresAt: null, plan: catalog.oneTime });
});

const list = async (session: TestSession | null, query: string) => callRoute(jar, listRoute.GET, { path: `/api/admin/renewals?q=${encodeURIComponent(`Iyer Pharmacy ${tag}`)}&${query}`, session });
const rowsOf = async (res: Response) => (await res.json()) as { items: AdminRenewalRow[]; total: number };
const remind = (session: TestSession | null, licenseIds: string[]) =>
  callRoute(jar, remindRoute.POST, { method: "POST", path: "/api/admin/renewals/remind", session, body: { licenseIds } });

describe("list", () => {
  it("holds the licenses ending in the next 60 days or ended in the last 30, soonest first", async () => {
    const res = await list(callers.FINANCE, "");
    expect(res.status).toBe(200);
    const { items, total } = await rowsOf(res);
    expect(total).toBe(4);
    expect(items.map((r) => r.id)).toEqual([L.lapsed, L.due5, L.due10, L.due45]);
    const lapsed = items[0]!;
    expect(lapsed.daysLeft).toBe(-3);
    expect(lapsed.customerName).toBe(`Iyer Pharmacy ${tag}`);
    expect(items.find((r) => r.id === L.due10)?.daysLeft).toBe(11);
    expect(items.find((r) => r.id === L.due45)?.renewalValuePaise).toBe(catalog.annual.pricePaise);
  });

  it("filters by window", async () => {
    const ids = async (w: string) => (await rowsOf(await list(callers.SUPPORT, `filter[window]=${w}`))).items.map((r) => r.id).sort();
    expect(await ids("30")).toEqual([L.due10, L.due5].sort());
    expect(await ids("60")).toEqual([L.due45]);
    expect(await ids("lapsed")).toEqual([L.lapsed]);
  });

  it("counts the stats over the whole row set", async () => {
    const stats = await adminRenewalStats(db, new Date());
    expect(stats.dueSoon).toBeGreaterThanOrEqual(2);
    expect(stats.dueLater).toBeGreaterThanOrEqual(1);
    expect(stats.lapsed).toBeGreaterThanOrEqual(1);
    expect(stats.valuePaise).toBeGreaterThanOrEqual(4 * catalog.annual.pricePaise);
  });
});

describe("send reminder now", () => {
  it("queues the template that fits each license to owners and billing admins, once a day, with one audit row each", async () => {
    expect((await remind(callers.FINANCE, [L.due10!])).status).toBe(403);
    const res = await remind(callers.SUPPORT, [L.due10!, L.due5!, L.lapsed!, L.far!, L.revoked!]);
    expect(res.status).toBe(200);
    const result = (await res.json()) as RemindResult;
    const byId = Object.fromEntries(result.queued.map((q) => [q.id, q]));
    expect(byId[L.due10!]).toMatchObject({ templateId: "renewal_30", recipients: 2 });
    expect(byId[L.due5!]).toMatchObject({ templateId: "renewal_7", recipients: 2 });
    expect(byId[L.lapsed!]).toMatchObject({ templateId: "license_expired", recipients: 2 });
    expect(result.skipped).toEqual(expect.arrayContaining([{ id: L.far, reason: "Not due for renewal" }, { id: L.revoked, reason: "Revoked" }]));

    const rows = await db.outboxEmail.findMany({ where: { dedupeKey: { startsWith: renewalReminderPrefix(L.due10!) } } });
    expect(rows.map((r) => r.to).sort()).toHaveLength(2);
    expect(rows.every((r) => r.templateId === "renewal_30" && r.text.includes(`/account/licenses/${L.due10}`))).toBe(true);
    expect(rows.map((r) => r.to)).toContain(owner.user.email);
    const audit = await db.auditLog.findMany({ where: { targetType: "license", targetId: L.due10, action: "Sent renewal reminder" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toContain("renewal_30");

    const again = (await (await remind(callers.ADMIN, [L.due10!])).json()) as RemindResult;
    expect(again).toEqual({ queued: [], skipped: [{ id: L.due10, reason: "Already sent today" }] });
    expect(await db.outboxEmail.count({ where: { dedupeKey: { startsWith: renewalReminderPrefix(L.due10!) } } })).toBe(2);

    const { items } = await rowsOf(await list(callers.SUPPORT, ""));
    expect(items.find((r) => r.id === L.due10)?.lastReminderAt).not.toBeNull();
    expect(items.find((r) => r.id === L.due45)?.lastReminderAt).toBeNull();
  });

  it("validates the body", async () => {
    expect((await remind(callers.OWNER, [])).status).toBe(422);
  });
});

describe("scheduled reminders", () => {
  it("queue renewal_30 at 23-30 days and renewal_7 in the last week, once per term", async () => {
    const now = Date.now();
    const make = async (opts: Partial<Parameters<typeof makeLicense>[1]>) => (await makeLicense(catalog, { accountId: owner.accountId, ...opts })).license.id;
    const at25 = await make({ expiresAt: new Date(now + 25 * DAY) });
    const at3 = await make({ expiresAt: new Date(now + 3 * DAY) });
    const at15 = await make({ expiresAt: new Date(now + 15 * DAY) });
    const suspended = await make({ expiresAt: new Date(now + 25 * DAY), status: "SUSPENDED" });
    const mailsFor = (id: string) => db.outboxEmail.findMany({ where: { dedupeKey: { startsWith: renewalReminderPrefix(id) } }, select: { templateId: true } });

    // The daily job: GET /api/cron/renewals with the cron secret (401 without it).
    const cron = (authorization?: string) =>
      cronRoute.GET(new NextRequest("http://localhost:3000/api/cron/renewals", { headers: authorization ? { authorization } : {} }), undefined);
    expect((await cron()).status).toBe(401);
    expect((await cron("Bearer wrong-secret")).status).toBe(401);
    expect(await mailsFor(at25)).toEqual([]);
    const run = await cron(`Bearer ${process.env.CRON_SECRET}`);
    expect(run.status).toBe(200);
    expect(run.headers.get("cache-control")).toBe("no-store");
    expect(((await run.json()) as { queued: number }).queued).toBeGreaterThanOrEqual(2);
    expect((await mailsFor(at25)).map((m) => m.templateId)).toEqual(["renewal_30", "renewal_30"]);
    expect((await mailsFor(at3)).map((m) => m.templateId)).toEqual(["renewal_7", "renewal_7"]);
    expect(await mailsFor(at15)).toEqual([]);
    expect(await mailsFor(suspended)).toEqual([]);

    await sendScheduledRenewalReminders();
    expect(await mailsFor(at25)).toHaveLength(2);
    expect(await mailsFor(at3)).toHaveLength(2);
    expect(await db.auditLog.count({ where: { targetId: { in: [at25, at3] } } })).toBe(0);
  });
});
