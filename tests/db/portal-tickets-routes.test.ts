/**
 * Support ticket routes end to end: create (product/license checks, counter id, first message, activity with actor),
 * list (tabs, search, counts, paging), detail (internal notes hidden), reply (status back to OPEN), resolve/reopen
 * (CLOSED and auto-closed tickets cannot reopen), team roles (Viewer reads only) and account scoping (IDOR).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as detailGET } from "@/app/api/account/tickets/[id]/route";
import { POST as replyPOST } from "@/app/api/account/tickets/[id]/messages/route";
import { POST as statusPOST } from "@/app/api/account/tickets/[id]/status/route";
import { GET as listGET, POST as createPOST } from "@/app/api/account/tickets/route";
import { db } from "@/lib/db";
import { bodyOf, call, errorOf, makeCatalog, makeLicense, makeMember, signIn, type Catalog, type Member } from "./license-actions-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: { maxAge?: number } = {}) => {
      if (options.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

const DAY = 86_400_000;
let catalog: Catalog;
let owner: Member;

beforeAll(async () => {
  catalog = await makeCatalog();
});
beforeEach(async () => {
  owner = await makeMember({ name: "Priya Sharma" });
  await signIn(jar, owner);
});

const ticketBody = (extra: Record<string, unknown> = {}) => ({
  productId: catalog.product.id,
  subject: "Barcode scanner stops working",
  body: "Since updating this morning the USB scanner does not enter anything.",
  ...extra,
});
const create = (body: unknown = ticketBody(), opts: { csrf?: boolean } = {}) =>
  call(jar, createPOST, "/api/account/tickets", { method: "POST", body, ...opts });
const list = (query = "") => call(jar, listGET, `/api/account/tickets${query ? `?${query}` : ""}`);
const detail = (id: string) => call(jar, detailGET, `/api/account/tickets/${id}`, { params: { id } });
const reply = (id: string, body: unknown) => call(jar, replyPOST, `/api/account/tickets/${id}/messages`, { method: "POST", body, params: { id } });
const status = (id: string, action: string) =>
  call(jar, statusPOST, `/api/account/tickets/${id}/status`, { method: "POST", body: { action }, params: { id } });

type Detail = { ticket: Record<string, unknown> & { id: string; status: string }; messages: Array<Record<string, unknown>> };

async function openTicket(extra: Record<string, unknown> = {}): Promise<Detail> {
  const res = await create(ticketBody(extra));
  expect(res.status).toBe(201);
  return (await res.json()) as Detail;
}

describe("create", () => {
  it("opens a ticket with a counter id, the first message, the opener and an activity entry", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const body = await openTicket({ licenseId: license.id, impact: "high" });
    expect(body.ticket.id).toMatch(/^T-\d+$/);
    expect(body.ticket).toMatchObject({
      status: "open",
      statusLabel: "Waiting for support",
      priority: "high",
      priorityLabel: "High",
      productId: catalog.product.id,
      productName: catalog.product.name,
      licenseId: license.id,
      raisedBy: "Priya Sharma",
      assigneeLabel: "Support queue",
      replyTarget: "1 business day",
      canReply: true,
      canResolve: true,
      canReopen: false,
    });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ body: ticketBody().body, author: { label: "Priya Sharma", isStaff: false, isYou: true } });

    const row = await db.supportTicket.findUniqueOrThrow({ where: { id: body.ticket.id } });
    expect(row).toMatchObject({ accountId: owner.accountId, openedById: owner.user.id, priority: "HIGH", status: "OPEN" });
    const activity = await db.accountActivity.findMany({ where: { accountId: owner.accountId, target: body.ticket.id } });
    expect(activity.map((a) => [a.action, a.kind, a.actorId, a.actorName])).toEqual([["Opened ticket", "ticket", owner.user.id, "Priya Sharma"]]);
  });

  it("masks a pasted license key in the subject and message", async () => {
    const { key } = await makeLicense(catalog, { accountId: owner.accountId });
    const body = await openTicket({ body: `My key ${key} stopped working after the update today.` });
    expect(body.messages[0]?.body).not.toContain(key);
    expect(String(body.messages[0]?.body)).toContain(`-${key.slice(-4)}`);
  });

  it("refuses unknown products, other accounts' licenses and licenses of another product (422)", async () => {
    const other = await makeMember();
    const { license: foreign } = await makeLicense(catalog, { accountId: other.accountId });
    const otherCatalog = await makeCatalog();
    const { license: otherProduct } = await makeLicense(otherCatalog, { accountId: owner.accountId });
    for (const [extra, field] of [
      [{ productId: "no-such-product" }, "productId"],
      [{ licenseId: foreign.id }, "licenseId"],
      [{ licenseId: otherProduct.id }, "licenseId"],
    ] as const) {
      const res = await create(ticketBody(extra));
      expect(res.status, field).toBe(422);
      expect(Object.keys((errorOf(await bodyOf(res)).fieldErrors ?? {}) as object)).toEqual([field]);
    }
    expect(await db.supportTicket.count({ where: { accountId: owner.accountId } })).toBe(0);
  });

  it("needs CSRF and a verified email", async () => {
    expect(errorOf(await bodyOf(await create(ticketBody(), { csrf: false }))).code).toBe("csrf_failed");
    const unverified = await makeMember({ verified: false });
    await signIn(jar, unverified);
    const res = await create();
    expect(res.status).toBe(403);
    expect(errorOf(await bodyOf(res)).code).toBe("email_unverified");
  });
});

describe("roles and account scoping", () => {
  it("lets a Viewer read tickets but not create, reply, resolve or reopen", async () => {
    const t = await openTicket();
    const viewer = await makeMember({ accountId: owner.accountId, role: "VIEWER", name: "Asha Viewer" });
    await signIn(jar, viewer);
    expect((await list()).status).toBe(200);
    const read = await detail(t.ticket.id);
    expect(read.status).toBe(200);
    expect(((await read.json()) as Detail).ticket).toMatchObject({ canReply: false, canResolve: false, canReopen: false });
    for (const res of [await create(), await reply(t.ticket.id, { body: "Hello" }), await status(t.ticket.id, "resolve")]) {
      expect(res.status).toBe(403);
      expect(errorOf(await bodyOf(res)).code).toBe("forbidden");
    }
  });

  it("lets Billing and Technical members raise tickets", async () => {
    for (const role of ["BILLING", "TECHNICAL"] as const) {
      const m = await makeMember({ accountId: owner.accountId, role, name: `Member ${role}` });
      await signIn(jar, m);
      expect((await create()).status, role).toBe(201);
    }
  });

  it("answers 404 for another account's ticket on every route and never lists it", async () => {
    const t = await openTicket();
    const stranger = await makeMember();
    await signIn(jar, stranger);
    for (const res of [await detail(t.ticket.id), await reply(t.ticket.id, { body: "Hi" }), await status(t.ticket.id, "resolve")]) {
      expect(res.status).toBe(404);
    }
    expect(((await (await list()).json()) as { total: number }).total).toBe(0);
    expect((await detail("not-a-ticket")).status).toBe(404);
    expect((await db.supportTicket.findUniqueOrThrow({ where: { id: t.ticket.id } })).status).toBe("OPEN");
  });
});

describe("list", () => {
  it("filters by tab and search, counts per tab, sorts and pages", async () => {
    const a = await openTicket({ subject: "Printer alignment is off" });
    const b = await openTicket({ subject: "GSTIN on B2B invoices" });
    const c = await openTicket({ subject: "Scanner beeps twice" });
    await db.supportTicket.update({ where: { id: b.ticket.id }, data: { status: "AWAITING_CUSTOMER" } });
    await db.supportTicket.update({ where: { id: c.ticket.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });

    const all = (await (await list()).json()) as { tickets: { id: string }[]; total: number; counts: Record<string, number> };
    expect(all.total).toBe(3);
    expect(all.counts).toEqual({ open: 2, awaiting_customer: 1, resolved: 1, all: 3 });
    const ids = (q: string) => list(q).then(async (r) => ((await r.json()) as { tickets: { id: string }[] }).tickets.map((t) => t.id));
    expect((await ids("status=open")).sort()).toEqual([a.ticket.id, b.ticket.id].sort());
    expect(await ids("status=awaiting_customer")).toEqual([b.ticket.id]);
    expect(await ids("status=resolved")).toEqual([c.ticket.id]);
    expect(await ids("q=gstin")).toEqual([b.ticket.id]);
    expect(await ids(`q=${a.ticket.id.toLowerCase()}`)).toEqual([a.ticket.id]);
    expect(await ids("sort=created")).toEqual([a.ticket.id, b.ticket.id, c.ticket.id]);
    expect(await ids("sort=-subject")).toEqual([c.ticket.id, a.ticket.id, b.ticket.id]);
    const page2 = (await (await list("page=2")).json()) as { tickets: unknown[]; pageCount: number; page: number };
    expect(page2).toMatchObject({ tickets: [], pageCount: 1, page: 2 });
    expect((await list("status=closed")).status).toBe(422);
  });
});

describe("detail and reply", () => {
  it("hides staff-only notes and labels staff replies", async () => {
    const t = await openTicket();
    const staff = await db.user.create({
      data: { email: `sneha.${Date.now()}@axiomatic.test`, name: "Sneha Patil", kind: "STAFF", staffRole: "SUPPORT", staffStatus: "ACTIVE" },
    });
    const note = { ticketId: t.ticket.id, authorId: staff.id, isStaff: true, attachments: [] };
    await db.ticketMessage.create({ data: { ...note, internal: true, body: "Internal: customer is on 4.2.1" } });
    await db.ticketMessage.create({ data: { ...note, body: "Please restart the app." } });
    await db.supportTicket.update({ where: { id: t.ticket.id }, data: { assigneeId: staff.id, status: "AWAITING_CUSTOMER" } });
    const body = (await (await detail(t.ticket.id)).json()) as Detail;
    expect(body.messages).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("Internal:");
    expect(body.messages[1]).toMatchObject({ author: { label: "Sneha \u00B7 Axiomatic Support", isStaff: true, isYou: false } });
    expect(body.ticket).toMatchObject({ status: "awaiting_customer", statusLabel: "Waiting for you", assigneeName: "Sneha" });
  });

  it("moves a ticket waiting for the customer back to support on reply", async () => {
    const t = await openTicket();
    await db.supportTicket.update({ where: { id: t.ticket.id }, data: { status: "AWAITING_CUSTOMER" } });
    const res = await reply(t.ticket.id, { body: "  It still does not work.  " });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Detail;
    expect(body.ticket.status).toBe("open");
    expect(body.messages.map((m) => m.body)).toEqual([ticketBody().body, "It still does not work."]);
    const replied = await db.accountActivity.count({ where: { accountId: owner.accountId, action: "Replied to ticket", actorId: owner.user.id } });
    expect(replied).toBe(1);
    const empty = await reply(t.ticket.id, { body: " " });
    expect(empty.status).toBe(422);
    expect(errorOf(await bodyOf(empty)).fieldErrors).toEqual({ body: ["Write a message before sending."] });
  });
});

describe("resolve and reopen", () => {
  it("resolves and reopens, refuses replies to resolved tickets, and never reopens closed ones", async () => {
    const t = await openTicket();
    const resolved = (await (await status(t.ticket.id, "resolve")).json()) as Detail;
    expect(resolved.ticket).toMatchObject({ status: "resolved", canReopen: true, canReply: false });
    expect((await db.supportTicket.findUniqueOrThrow({ where: { id: t.ticket.id } })).resolvedAt).not.toBeNull();
    expect((await status(t.ticket.id, "resolve")).status).toBe(200);
    const blocked = await reply(t.ticket.id, { body: "One more thing" });
    expect(blocked.status).toBe(409);
    expect(errorOf(await bodyOf(blocked)).code).toBe("ticket_resolved");
    const reopened = (await (await status(t.ticket.id, "reopen")).json()) as Detail;
    expect(reopened.ticket.status).toBe("open");
    const actions = await db.accountActivity.findMany({ where: { accountId: owner.accountId, target: t.ticket.id }, orderBy: { createdAt: "asc" } });
    expect(actions.map((a) => a.action)).toEqual(["Opened ticket", "Resolved ticket", "Reopened ticket"]);

    await db.supportTicket.update({ where: { id: t.ticket.id }, data: { status: "RESOLVED", resolvedAt: new Date(Date.now() - 15 * DAY) } });
    const old = (await (await detail(t.ticket.id)).json()) as Detail;
    expect(old.ticket).toMatchObject({ status: "closed", statusLabel: "Closed", canReopen: false });
    const late = await status(t.ticket.id, "reopen");
    expect(late.status).toBe(409);
    expect(errorOf(await bodyOf(late)).code).toBe("ticket_closed");
    await db.supportTicket.update({ where: { id: t.ticket.id }, data: { status: "CLOSED", resolvedAt: null } });
    expect(errorOf(await bodyOf(await status(t.ticket.id, "reopen"))).code).toBe("ticket_closed");
    expect(errorOf(await bodyOf(await reply(t.ticket.id, { body: "Hello?" }))).code).toBe("ticket_closed");
    expect((await status(t.ticket.id, "close")).status).toBe(422);
  });
});
