/**
 * Admin Leads inbox (decisions.md Phase 6, leads.view): list with search, Type / Status filters, sort and paging;
 * the status workflow with notes kept as the audit reason (the lead's history); CSV for reports.export only.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LeadKind, LeadStatus } from "@/generated/prisma/enums";
import * as item from "@/app/api/admin/leads/[id]/route";
import * as exportCsv from "@/app/api/admin/leads/export.csv/route";
import * as collection from "@/app/api/admin/leads/route";
import { leadUpdateSchema } from "@/lib/admin/leads/schemas";
import { getLeadDetail, leadStats, listLeads, updateLead } from "@/lib/admin/leads/service";
import { db } from "@/lib/db";
import { callRoute, makeAdminCallers, type AdminCallers } from "../support/admin-fixtures";
import { auditRows, makeProduct, rejection, staffFixture, TAG, type StaffFixture } from "./admin-coupons-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

let support: StaffFixture;
let callers: AdminCallers;
let product: { id: string; name: string };
const T = TAG();

async function lead(kind: LeadKind, n: number, extra: { status?: LeadStatus; name?: string; minutesAgo?: number } = {}) {
  return db.lead.create({
    data: {
      id: `${kind === "DEMO" ? "DEMO" : "MSG"}-T${T}${n}`,
      kind,
      status: extra.status ?? "NEW",
      name: extra.name ?? `Visitor ${n}`,
      businessName: `Leads ${T}`,
      email: `lead${n}.${T.toLowerCase()}@example.test`,
      phone: "9820012345",
      productId: kind === "DEMO" ? product.id : null,
      countersBand: kind === "DEMO" ? "2-3" : null,
      preferredDate: kind === "DEMO" ? "2026-10-12" : null,
      preferredSlot: kind === "DEMO" ? "morning" : null,
      topic: kind === "CONTACT" ? "licensing" : null,
      message: "Please call me.",
      createdAt: new Date(Date.now() - (extra.minutesAgo ?? n) * 60_000),
    },
  });
}

beforeAll(async () => {
  product = await makeProduct();
  [support, callers] = await Promise.all([staffFixture("SUPPORT"), makeAdminCallers()]);
  await lead("DEMO", 1, { name: "Asha", minutesAgo: 30 });
  await lead("CONTACT", 2, { name: "Bala", minutesAgo: 20 });
  await lead("DEMO", 3, { name: "Chitra", status: "CONTACTED", minutesAgo: 10 });
  await lead("CONTACT", 4, { name: "Deepak", status: "SPAM", minutesAgo: 5 });
});

const query = (overrides: Record<string, unknown> = {}) => ({
  q: `Leads ${T}`,
  filters: {},
  sort: { id: "received" as const, desc: true },
  page: 1,
  pageSize: 25,
  ...overrides,
});

describe("listLeads", () => {
  it("searches, filters, sorts and pages, with labels for the drawer", async () => {
    const all = await listLeads(query());
    expect(all.items.map((l) => l.name)).toEqual(["Deepak", "Chitra", "Bala", "Asha"]);
    const demo = all.items.find((l) => l.name === "Asha");
    expect(demo).toMatchObject({
      kindLabel: "Demo request",
      status: "new",
      phone: "+91 98200 12345",
      productName: product.name,
      countersLabel: "2\u20133",
      preferredLabel: "12 Oct 2026, Morning (10\u20131)",
    });
    expect(all.items.find((l) => l.name === "Bala")?.topicLabel).toBe("Licensing or billing");

    const demos = await listLeads(query({ filters: { kind: "demo" }, sort: { id: "name", desc: false } }));
    expect(demos.items.map((l) => l.name)).toEqual(["Asha", "Chitra"]);
    const spam = await listLeads(query({ filters: { status: "spam" } }));
    expect(spam.items.map((l) => l.name)).toEqual(["Deepak"]);
    const byId = await listLeads(query({ q: `DEMO-T${T}3` }));
    expect(byId.items.map((l) => l.name)).toEqual(["Chitra"]);
    const page2 = await listLeads(query({ pageSize: 3, page: 2 }));
    expect(page2).toMatchObject({ total: 4, page: 2, items: [{ name: "Asha" }] });
    const stats = await leadStats();
    expect(stats.new).toBeGreaterThanOrEqual(2);
  });
});

describe("updateLead", () => {
  it("changes the status with the note as the audit reason, and adds notes alone", async () => {
    const id = `DEMO-T${T}1`;
    const res = await updateLead(id, { status: "scheduled", note: "Demo on Friday 11 am" }, { actor: support.actor });
    expect(res).toMatchObject({ changed: true, lead: { status: "scheduled" } });
    await updateLead(id, { note: "Sent the joining link" }, { actor: support.actor });
    const rows = await auditRows("lead", id);
    expect(rows.map((r) => [r.action, r.detail, r.reason, r.target])).toEqual([
      ["Changed lead status", "New \u2192 Scheduled", "Demo on Friday 11 am", id],
      ["Added lead note", null, "Sent the joining link", id],
    ]);
    const detail = await getLeadDetail(id);
    expect(detail.history.map((h) => h.action)).toEqual(["Added lead note", "Changed lead status"]);
    expect(detail.history[0]?.actorName).toBe(support.user.name);
  });

  it("allows Scheduled only for demo requests, needs a change, and 404s unknown ids", async () => {
    const msg = `MSG-T${T}2`;
    const err = await rejection(updateLead(msg, { status: "scheduled" }, { actor: support.actor }));
    expect(err).toMatchObject({ status: 422 });
    expect(await rejection(updateLead(msg, {}, { actor: support.actor }))).toMatchObject({ status: 422 });
    expect((await updateLead(msg, { status: "new" }, { actor: support.actor })).changed).toBe(false);
    expect(await rejection(updateLead("MSG-NOPE", { status: "closed" }, { actor: support.actor }))).toMatchObject({ status: 404 });
    expect(leadUpdateSchema.safeParse({ status: "won" }).success).toBe(false);
    expect(leadUpdateSchema.safeParse({ note: "x".repeat(501) }).success).toBe(false);
  });
});

describe("lead routes", () => {
  it("is leads.view only (Finance 403), Support can update, CSV needs leads.view and reports.export", async () => {
    const finance = await callRoute(jar, collection.GET, { path: "/api/admin/leads", session: callers.FINANCE });
    expect(finance.status).toBe(403);
    const list = await callRoute(jar, collection.GET, { path: `/api/admin/leads?q=${encodeURIComponent(`Leads ${T}`)}&filter[kind]=contact`, session: callers.SUPPORT });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { name: string }[]; stats: Record<string, number> };
    expect(body.items.map((l) => l.name)).toEqual(["Deepak", "Bala"]);
    expect(Object.keys(body.stats)).toEqual(["new", "contacted", "scheduled", "closed", "spam"]);

    const id = `MSG-T${T}2`;
    const patch = await callRoute(jar, item.PATCH, { method: "PATCH", path: `/api/admin/leads/${id}`, params: { id }, body: { status: "closed", note: "Answered by email" }, session: callers.SUPPORT });
    expect(patch.status).toBe(200);

    const supportCsv = await callRoute(jar, exportCsv.GET, { path: "/api/admin/leads/export.csv", session: callers.SUPPORT });
    expect(supportCsv.status).toBe(403);
    const financeCsv = await callRoute(jar, exportCsv.GET, { path: "/api/admin/leads/export.csv", session: callers.FINANCE });
    expect(financeCsv.status).toBe(403);
    const csv = await callRoute(jar, exportCsv.GET, { path: `/api/admin/leads/export.csv?q=${encodeURIComponent(`Leads ${T}`)}`, session: callers.OWNER });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("x-row-count")).toBe("4");
    expect(await csv.text()).toContain('"Reference","Type","Status","Received (IST)"');
  });
});
