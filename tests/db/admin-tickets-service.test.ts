/**
 * Staff ticket services (decisions.md Phase 6 "Tickets (staff)"): the list's filters, search and sort, derived
 * Closed, the first-response stat, status / priority / assignee changes with their audit rows, the bulk bar, and
 * what a public reply and an internal note do (status, firstResponseAt, assignment, notification, ticket_reply
 * email, customer activity), including that internal notes never reach the portal.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { User } from "@/generated/prisma/client";
import { parseAdminTicketQuery } from "@/lib/admin/tickets/model";
import { staffMessageSchema } from "@/lib/admin/tickets/schema";
import {
  addStaffMessage,
  bulkUpdateTickets,
  getAdminTicket,
  listAdminTickets,
  ticketAssignees,
  ticketStats,
  updateAdminTicket,
} from "@/lib/admin/tickets/service";
import { db } from "@/lib/db";
import { getTicketDetail, listTickets } from "@/lib/portal/tickets";
import { actorOf, makeCustomer, makeStaffSet, makeTicket, staffOf, tag, type StaffSet } from "./admin-tickets-fixtures";

const DAY = 86_400_000;
let staff: StaffSet;
let customer: { user: User; accountId: string };

beforeAll(async () => {
  staff = await makeStaffSet();
  customer = await makeCustomer();
});

const message = (body: string, internal = false, attachmentIds: string[] = []) => staffMessageSchema.parse({ body, internal, attachmentIds });

async function auditRows(ticketId: string) {
  return db.auditLog.findMany({ where: { targetType: "ticket", targetId: ticketId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

describe("list", () => {
  it("filters by status (Closed derived 14 days after resolution), priority, assignee and product, and searches", async () => {
    const t = tag();
    const now = new Date();
    const product = await db.product.findFirst({ select: { id: true } });
    const base = { accountId: customer.accountId, openedById: customer.user.id };
    const open = await makeTicket({ ...base, subject: `Scanner ${t} open`, priority: "HIGH", assigneeId: staff.support.id, productId: product?.id ?? null });
    const waiting = await makeTicket({ ...base, subject: `Scanner ${t} waiting`, status: "AWAITING_CUSTOMER" });
    const resolved = await makeTicket({ ...base, subject: `Scanner ${t} resolved`, status: "RESOLVED", resolvedAt: new Date(now.getTime() - 2 * DAY) });
    const old = await makeTicket({ ...base, subject: `Scanner ${t} old`, status: "RESOLVED", resolvedAt: new Date(now.getTime() - 15 * DAY), priority: "LOW" });
    const ids = async (qs: string, staffId = staff.support.id) =>
      (await listAdminTickets({ query: parseAdminTicketQuery(`q=${t}&${qs}`), staffId, now })).items.map((r) => r.id).sort();

    expect(await ids("")).toEqual([open, waiting, resolved, old].sort());
    expect(await ids("filter[status]=open")).toEqual([open]);
    expect(await ids("filter[status]=awaiting_customer")).toEqual([waiting]);
    expect(await ids("filter[status]=resolved")).toEqual([resolved]);
    expect(await ids("filter[status]=closed")).toEqual([old]);
    expect(await ids("filter[priority]=high")).toEqual([open]);
    expect(await ids("filter[assignee]=me")).toEqual([open]);
    expect(await ids("filter[assignee]=me", staff.admin.id)).toEqual([]);
    expect(await ids(`filter[assignee]=${staff.support.id}`)).toEqual([open]);
    expect(await ids("filter[assignee]=none")).toEqual([waiting, resolved, old].sort());
    if (product) expect(await ids(`filter[product]=${product.id}`)).toEqual([open]);

    const page = await listAdminTickets({ query: parseAdminTicketQuery(`q=${t}`), staffId: staff.support.id, now });
    const row = page.items.find((r) => r.id === old);
    expect(row).toMatchObject({ status: "closed", priority: "low", customer: { email: customer.user.email }, assignee: null });
    expect(page).toMatchObject({ total: 4, page: 1, pageSize: 25 });

    // Search by id, business and customer email too.
    expect((await listAdminTickets({ query: parseAdminTicketQuery(`q=${open}`), staffId: staff.support.id, now })).items.map((r) => r.id)).toContain(open);
    const account = await db.businessAccount.findUniqueOrThrow({ where: { id: customer.accountId } });
    const byBusiness = await listAdminTickets({ query: parseAdminTicketQuery(`q=${encodeURIComponent(account.legalName)}`), staffId: staff.support.id, now });
    expect(byBusiness.items.map((r) => r.id)).toEqual(expect.arrayContaining([open, waiting]));
    const byEmail = await listAdminTickets({ query: parseAdminTicketQuery(`q=${encodeURIComponent(customer.user.email)}`), staffId: staff.support.id, now });
    expect(byEmail.items.map((r) => r.id)).toEqual(expect.arrayContaining([open, waiting, resolved, old]));
  });

  it("sorts priority High first ascending and ids in opening order", async () => {
    const t = tag();
    const base = { accountId: customer.accountId, openedById: customer.user.id };
    const low = await makeTicket({ ...base, subject: `Sort ${t} a`, priority: "LOW", createdAt: new Date(Date.now() - 3000) });
    const high = await makeTicket({ ...base, subject: `Sort ${t} b`, priority: "HIGH", createdAt: new Date(Date.now() - 2000) });
    const normal = await makeTicket({ ...base, subject: `Sort ${t} c`, priority: "NORMAL", createdAt: new Date(Date.now() - 1000) });
    const order = async (sort: string) =>
      (await listAdminTickets({ query: parseAdminTicketQuery(`q=${t}&sort=${sort}`), staffId: staff.owner.id })).items.map((r) => r.id);
    expect(await order("priority")).toEqual([high, normal, low]);
    expect(await order("-priority")).toEqual([low, normal, high]);
    expect(await order("id")).toEqual([low, high, normal]);
    expect(await order("-id")).toEqual([normal, high, low]);
  });

  it("offers active staff who handle tickets as assignees (never Finance or deactivated staff)", async () => {
    const ids = (await ticketAssignees()).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([staff.owner.id, staff.admin.id, staff.support.id]));
    expect(ids).not.toContain(staff.finance.id);
  });
});

describe("stats", () => {
  it("counts open, awaiting customer, and unassigned / high priority among them", async () => {
    const before = await ticketStats(db);
    const base = { accountId: customer.accountId, openedById: customer.user.id };
    await makeTicket({ ...base, priority: "HIGH" });
    await makeTicket({ ...base, status: "AWAITING_CUSTOMER", assigneeId: staff.support.id });
    await makeTicket({ ...base, status: "RESOLVED", resolvedAt: new Date(), priority: "HIGH" });
    const after = await ticketStats(db);
    expect({
      open: after.open - before.open,
      awaitingCustomer: after.awaitingCustomer - before.awaitingCustomer,
      unassigned: after.unassigned - before.unassigned,
      highPriority: after.highPriority - before.highPriority,
    }).toEqual({ open: 1, awaitingCustomer: 1, unassigned: 1, highPriority: 1 });
  });
});

describe("first response time", () => {
  it("is the median time to the first public staff reply of tickets opened in the last 30 days", async () => {
    // A future window, so only this test's tickets fall into it.
    const now = new Date(Date.UTC(2031, 0, 31, 12));
    const at = (days: number, hours = 0) => new Date(now.getTime() - days * DAY + hours * 3_600_000);
    const base = { accountId: customer.accountId, openedById: customer.user.id };
    await makeTicket({ ...base, createdAt: at(3), firstResponseAt: at(3, 1) }); // 1 h
    await makeTicket({ ...base, createdAt: at(4), firstResponseAt: at(4, 3) }); // 3 h
    // Answered before firstResponseAt existed: the first public staff message counts (2 h); the earlier note does not.
    const legacy = await makeTicket({
      ...base,
      createdAt: at(5),
      messages: [
        { authorId: customer.user.id, at: at(5) },
        { authorId: staff.support.id, isStaff: true, internal: true, at: at(5, 0.5) },
        { authorId: staff.support.id, isStaff: true, at: at(5, 2) },
      ],
    });
    await makeTicket({ ...base, createdAt: at(6) }); // not answered yet: left out
    await makeTicket({ ...base, createdAt: at(40), firstResponseAt: at(40, 20) }); // outside the window
    const stats = await ticketStats(db, now);
    expect(stats.firstResponseSample).toBe(3);
    expect(stats.firstResponseMedianMs).toBe(2 * 3_600_000);
    // The drawer uses the same definition.
    expect((await getAdminTicket({ ticketId: legacy, now })).ticket.firstResponseAt).toBe(at(5, 2).toISOString());
  });
});

describe("status, priority and assignee", () => {
  it("writes one audit row per change in one go and ignores values that did not change", async () => {
    const id = await makeTicket({ accountId: customer.accountId, openedById: customer.user.id, priority: "NORMAL" });
    const result = await updateAdminTicket({
      ticketId: id,
      patch: { status: "resolved", priority: "high", assigneeId: staff.admin.id },
      staff: staffOf(staff.support),
      actor: actorOf(staff.support),
    });
    expect(result.changed).toEqual(["status", "priority", "assignee"]);
    expect(result.detail.ticket).toMatchObject({ status: "resolved", priority: "high", assignee: { id: staff.admin.id } });
    const rows = await auditRows(id);
    expect(rows.map((r) => [r.action, r.detail])).toEqual([
      ["Resolved ticket", "Open \u2192 Resolved"],
      ["Changed ticket priority", "Normal \u2192 High"],
      ["Assigned ticket", `to ${staff.admin.name}`],
    ]);
    expect(rows.every((r) => r.actorId === staff.support.id && r.actorRole === "support")).toBe(true);
    const stored = await db.supportTicket.findUniqueOrThrow({ where: { id } });
    expect(stored.resolvedAt).not.toBeNull();
    // The customer's activity log shows the resolution (by Axiomatic Support, no person id).
    const activity = await db.accountActivity.findFirst({ where: { accountId: customer.accountId, target: id, action: "Resolved ticket" } });
    expect(activity).toMatchObject({ actorId: null, actorName: "Sneha (Axiomatic Support)", kind: "ticket" });

    const again = await updateAdminTicket({ ticketId: id, patch: { priority: "high" }, staff: staffOf(staff.support), actor: actorOf(staff.support) });
    expect(again.changed).toEqual([]);
    expect(await auditRows(id)).toHaveLength(3);

    const reopened = await updateAdminTicket({ ticketId: id, patch: { status: "open", assigneeId: null }, staff: staffOf(staff.owner), actor: actorOf(staff.owner) });
    expect(reopened.detail.ticket).toMatchObject({ status: "open", assignee: null, resolvedAt: null });
    expect((await auditRows(id)).slice(3).map((r) => r.action)).toEqual(["Reopened ticket", "Unassigned ticket"]);
  });

  it("refuses assignees who do not handle tickets (Finance, customers, unknown) with 422 and changes nothing", async () => {
    const id = await makeTicket({ accountId: customer.accountId, openedById: customer.user.id, priority: "LOW" });
    for (const assigneeId of [staff.finance.id, customer.user.id, "no-such-user"]) {
      await expect(
        updateAdminTicket({ ticketId: id, patch: { priority: "high", assigneeId }, staff: staffOf(staff.owner), actor: actorOf(staff.owner) }),
      ).rejects.toMatchObject({ status: 422 });
    }
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({ priority: "LOW", assigneeId: null });
    expect(await auditRows(id)).toHaveLength(0);
  });

  it("404s for unknown tickets", async () => {
    await expect(getAdminTicket({ ticketId: "T-999999999" })).rejects.toMatchObject({ status: 404 });
    await expect(
      updateAdminTicket({ ticketId: "T-999999999", patch: { status: "open" }, staff: staffOf(staff.owner), actor: actorOf(staff.owner) }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("bulk: assigns to me and resolves only what still needs it, reporting the rest", async () => {
    const base = { accountId: customer.accountId, openedById: customer.user.id };
    const a = await makeTicket(base);
    const b = await makeTicket({ ...base, assigneeId: staff.support.id, status: "AWAITING_CUSTOMER" });
    const c = await makeTicket({ ...base, status: "RESOLVED", resolvedAt: new Date() });
    const assign = await bulkUpdateTickets({ data: { action: "assign_to_me", ids: [a, b, "T-999999998"] }, staff: staffOf(staff.support), actor: actorOf(staff.support) });
    expect(assign).toEqual({ updated: [a], unchanged: [b], missing: ["T-999999998"] });
    const resolve = await bulkUpdateTickets({ data: { action: "resolve", ids: [a, b, c] }, staff: staffOf(staff.support), actor: actorOf(staff.support) });
    expect(resolve).toEqual({ updated: [a, b], unchanged: [c], missing: [] });
    expect((await auditRows(a)).map((r) => r.action)).toEqual(["Assigned ticket", "Resolved ticket"]);
    expect((await auditRows(c)).length).toBe(0);
  });
});

describe("replies and internal notes", () => {
  it("a public reply: awaiting customer, first response once, assigned to the replier, notification + email, activity", async () => {
    const opened = new Date(Date.now() - 3 * 3_600_000);
    const id = await makeTicket({ accountId: customer.accountId, openedById: customer.user.id, subject: "Scanner stops", createdAt: opened });
    const now = new Date();
    const result = await addStaffMessage({
      ticketId: id,
      data: message("Please switch keyboard wedge mode off and on again."),
      staff: staffOf(staff.support),
      actor: actorOf(staff.support),
      now,
    });
    expect(result).toMatchObject({ notified: true, emailed: true });
    expect(result.detail.ticket).toMatchObject({ status: "awaiting_customer", assignee: { id: staff.support.id }, firstResponseAt: now.toISOString() });
    expect(result.detail.messages.at(-1)).toMatchObject({ internal: false, author: { id: staff.support.id, isStaff: true } });

    const stored = await db.ticketMessage.findUniqueOrThrow({ where: { id: result.messageId } });
    expect(stored).toMatchObject({ isStaff: true, internal: false, authorId: staff.support.id });
    const notification = await db.notification.findFirstOrThrow({ where: { userId: customer.user.id, href: `/account/tickets/${id}` } });
    expect(notification).toMatchObject({ kind: "ticket", title: `Support replied to ${id}`, body: "Sneha replied to \u201CScanner stops\u201D." });
    const email = await db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey: `ticket_reply:${result.messageId}` } });
    expect(email).toMatchObject({ templateId: "ticket_reply", to: customer.user.email, status: "PENDING" });
    expect(email.subject).toContain(id);
    expect(email.text).toContain(`/account/tickets/${id}`);
    expect(email.text).not.toContain("keyboard wedge");
    const audit = await auditRows(id);
    expect(audit.map((r) => [r.action, r.detail])).toEqual([
      ["Replied to ticket", `Open \u2192 Awaiting customer \u00B7 first response \u00B7 assigned to ${staff.support.name}`],
    ]);
    const activity = await db.accountActivity.findFirstOrThrow({ where: { accountId: customer.accountId, target: id, action: "Replied to ticket" } });
    expect(activity).toMatchObject({ actorId: null, actorName: "Sneha (Axiomatic Support)" });

    // A second reply keeps the first response time and the assignee.
    const later = new Date(now.getTime() + 60_000);
    const second = await addStaffMessage({ ticketId: id, data: message("Any luck?"), staff: staffOf(staff.admin), actor: actorOf(staff.admin), now: later });
    expect(second.detail.ticket).toMatchObject({ firstResponseAt: now.toISOString(), assignee: { id: staff.support.id } });
    expect((await auditRows(id)).at(-1)?.detail).toBeNull();
  });

  it("reopens a resolved ticket and masks full license keys", async () => {
    const id = await makeTicket({ accountId: customer.accountId, openedById: customer.user.id, status: "RESOLVED", resolvedAt: new Date() });
    const key = "MED-7Q4K-9XTP-W2HD-K8NM";
    const result = await addStaffMessage({ ticketId: id, data: message(`Use key ${key} again.`), staff: staffOf(staff.owner), actor: actorOf(staff.owner) });
    expect(result.detail.ticket).toMatchObject({ status: "awaiting_customer", resolvedAt: null });
    const body = result.detail.messages.at(-1)?.body ?? "";
    expect(body).not.toContain(key);
    expect(body).toContain("K8NM");
  });

  it("emails nobody when the opener turned ticket emails off, but still notifies in the portal", async () => {
    const other = await makeCustomer();
    await db.user.update({ where: { id: other.user.id }, data: { notificationPrefs: { tickets: false } } });
    const id = await makeTicket({ accountId: other.accountId, openedById: other.user.id });
    const result = await addStaffMessage({ ticketId: id, data: message("Fixed in 4.2.2."), staff: staffOf(staff.support), actor: actorOf(staff.support) });
    expect(result).toMatchObject({ notified: true, emailed: false });
    expect(await db.outboxEmail.count({ where: { dedupeKey: `ticket_reply:${result.messageId}` } })).toBe(0);
    expect(await db.notification.count({ where: { userId: other.user.id, href: `/account/tickets/${id}` } })).toBe(1);
  });

  it("notifies nobody when the opener is no longer an active member of the account", async () => {
    const other = await makeCustomer();
    const id = await makeTicket({ accountId: other.accountId, openedById: other.user.id });
    await db.accountMember.deleteMany({ where: { accountId: other.accountId, userId: other.user.id } });
    const result = await addStaffMessage({ ticketId: id, data: message("Hello again."), staff: staffOf(staff.support), actor: actorOf(staff.support) });
    expect(result).toMatchObject({ notified: false, emailed: false });
    expect(await db.notification.count({ where: { userId: other.user.id } })).toBe(0);
  });

  it("an internal note changes nothing the customer sees and never reaches the portal", async () => {
    const opened = new Date(Date.now() - 60_000);
    const id = await makeTicket({ accountId: customer.accountId, openedById: customer.user.id, createdAt: opened });
    const notesBefore = await db.notification.count({ where: { userId: customer.user.id } });
    const result = await addStaffMessage({
      ticketId: id,
      data: message("Customer is on 4.2.1; escalate to dev if wedge mode is on.", true),
      staff: staffOf(staff.support),
      actor: actorOf(staff.support),
    });
    expect(result).toMatchObject({ notified: false, emailed: false });
    const stored = await db.supportTicket.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ status: "OPEN", firstResponseAt: null, assigneeId: null });
    expect(stored.updatedAt.getTime()).toBe(opened.getTime());
    expect(await db.notification.count({ where: { userId: customer.user.id } })).toBe(notesBefore);
    expect(await db.outboxEmail.count({ where: { dedupeKey: `ticket_reply:${result.messageId}` } })).toBe(0);
    expect(await db.accountActivity.count({ where: { accountId: customer.accountId, target: id } })).toBe(0);
    expect((await auditRows(id)).map((r) => r.action)).toEqual(["Added internal note"]);

    // Staff see it; the portal never returns it.
    const staffView = await getAdminTicket({ ticketId: id });
    expect(staffView.messages.map((m) => m.internal)).toEqual([false, true]);
    const portal = await getTicketDetail({ accountId: customer.accountId, userId: customer.user.id, role: "OWNER", ticketId: id });
    expect(portal.messages).toHaveLength(1);
    expect(JSON.stringify(portal)).not.toContain("escalate to dev");
    const listed = await listTickets({ accountId: customer.accountId, query: { status: "all", product: "all", q: id, sort: { key: "updated", dir: -1 }, page: 1 } });
    expect(listed.tickets.find((x) => x.id === id)?.status).toBe("open");
  });

  it("refuses empty messages", () => {
    expect(staffMessageSchema.safeParse({ body: " x " }).success).toBe(false);
    expect(staffMessageSchema.safeParse({ body: "ok", internal: true, extra: 1 }).success).toBe(false);
    expect(staffMessageSchema.parse({ body: "  Thanks  " })).toEqual({ body: "Thanks", internal: false, attachmentIds: [] });
  });
});
