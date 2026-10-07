/** Pure helpers of the staff tickets module: status vocabulary, list queries, display formats and request bodies. */
import { describe, expect, it } from "vitest";
import {
  ADMIN_TICKETS_LIST,
  deriveAdminTicketStatus,
  firstNameOf,
  firstResponseLabel,
  formatDuration,
  formatTicketDateTime,
  formatTicketTime,
  isActiveTicketStatus,
  parseAdminTicketQuery,
  relativeTicketTime,
  ticketQueryFromListState,
} from "@/lib/admin/tickets/model";
import { staffMessageError, staffMessageSchema, ticketBulkSchema, ticketPatchSchema } from "@/lib/admin/tickets/schema";
import { customerHref, licenseHref, messageAuthorLabel, staffAttachmentPath, ticketMetaPatch, ticketUploadsPath } from "@/components/admin/tickets/console-model";
import { parseListState } from "@/lib/url-state";

const DAY = 86_400_000;
const NOW = new Date("2026-10-07T08:10:00.000Z"); // 1:40 pm IST

describe("status", () => {
  it("reads RESOLVED as closed 14 days after resolution, like the portal", () => {
    expect(deriveAdminTicketStatus({ status: "OPEN", resolvedAt: null }, NOW)).toBe("open");
    expect(deriveAdminTicketStatus({ status: "AWAITING_CUSTOMER", resolvedAt: null }, NOW)).toBe("awaiting_customer");
    expect(deriveAdminTicketStatus({ status: "RESOLVED", resolvedAt: new Date(NOW.getTime() - 13 * DAY) }, NOW)).toBe("resolved");
    expect(deriveAdminTicketStatus({ status: "RESOLVED", resolvedAt: new Date(NOW.getTime() - 14 * DAY) }, NOW)).toBe("closed");
    expect(deriveAdminTicketStatus({ status: "RESOLVED", resolvedAt: null }, NOW)).toBe("resolved");
    expect(deriveAdminTicketStatus({ status: "CLOSED", resolvedAt: null }, NOW)).toBe("closed");
    expect(["open", "awaiting_customer", "resolved", "closed"].map((s) => isActiveTicketStatus(s as never))).toEqual([true, true, false, false]);
  });
});

describe("list queries", () => {
  it("parses the API query leniently (bad values fall back, page size capped)", () => {
    expect(
      parseAdminTicketQuery("q=%20scanner%20&filter[status]=awaiting_customer&filter[priority]=high&filter[assignee]=me&filter[product]=medical-billing&sort=priority&page=2&pageSize=500"),
    ).toEqual({
      q: "scanner",
      status: "awaiting_customer",
      priority: "high",
      assignee: "me",
      product: "medical-billing",
      sort: { id: "priority", desc: false },
      page: 2,
      pageSize: 100,
    });
    expect(parseAdminTicketQuery("filter[status]=deleted&filter[assignee]=a%20b&filter[product]=..%2Fx&sort=-secret&page=-1")).toEqual({
      q: "",
      sort: { id: "updatedAt", desc: true },
      page: 1,
      pageSize: 25,
    });
  });

  it("maps the page's URL state to the same query", () => {
    const state = parseListState(
      new URLSearchParams("q=gst&filter[status]=closed&filter[assignee]=none&sort=-id&page=3"),
      ADMIN_TICKETS_LIST,
    );
    expect(ticketQueryFromListState(state)).toEqual({ q: "gst", status: "closed", assignee: "none", sort: { id: "id", desc: true }, page: 3, pageSize: 25 });
    expect(ticketQueryFromListState(parseListState(new URLSearchParams(""), ADMIN_TICKETS_LIST))).toEqual({
      q: "",
      sort: { id: "updatedAt", desc: true },
      page: 1,
      pageSize: 25,
    });
  });
});

describe("display", () => {
  it("formats times in IST and durations compactly", () => {
    expect(formatTicketTime(NOW)).toBe("7 Oct, 1:40 pm");
    expect(formatTicketDateTime(NOW)).toBe("7 Oct 2026, 1:40 pm");
    expect(formatTicketTime(null)).toBe("\u2014");
    expect(relativeTicketTime(new Date(NOW.getTime() - 20_000), NOW)).toBe("just now");
    expect(relativeTicketTime(new Date(NOW.getTime() - 29 * 60_000), NOW)).toBe("29m ago");
    expect(relativeTicketTime(new Date(NOW.getTime() - 10 * 3_600_000), NOW)).toBe("10h ago");
    expect(relativeTicketTime(new Date(NOW.getTime() - 3 * DAY), NOW)).toBe("3d ago");
    expect(relativeTicketTime(new Date(NOW.getTime() - 40 * DAY), NOW)).toBe("28 Aug 2026");
    expect([20_000, 45 * 60_000, 134 * 60_000, 3 * 3_600_000, 28 * 3_600_000, 6 * DAY, -1].map(formatDuration)).toEqual([
      "under 1m",
      "45m",
      "2h 14m",
      "3h",
      "1d 4h",
      "6d",
      "\u2014",
    ]);
  });

  it("labels the first response and message authors", () => {
    const createdAt = NOW.toISOString();
    expect(firstResponseLabel({ createdAt, firstResponseAt: null })).toBe("Not yet \u00B7 target 1 business day");
    expect(firstResponseLabel({ createdAt, firstResponseAt: new Date(NOW.getTime() + 90 * 60_000).toISOString() })).toBe("1h 30m");
    expect(firstNameOf("  Sneha Patil ")).toBe("Sneha");
    const author = (isStaff: boolean) => ({ id: "u", name: "Sneha Patil", email: "s@x.test", isStaff });
    expect(messageAuthorLabel({ author: author(true), internal: false })).toBe("Sneha \u00B7 Axiomatic Support");
    expect(messageAuthorLabel({ author: author(true), internal: true })).toBe("Sneha Patil");
    expect(messageAuthorLabel({ author: author(false), internal: false })).toBe("Sneha Patil");
  });

  it("builds API paths and links with encoded segments", () => {
    expect(ticketUploadsPath("T-3018")).toBe("/api/admin/tickets/T-3018/uploads");
    expect(ticketUploadsPath("T-3018", "ck1")).toBe("/api/admin/tickets/T-3018/uploads/ck1/confirm");
    expect(staffAttachmentPath("T-3018", "ck1", true)).toBe("/api/admin/tickets/T-3018/attachments/ck1?redirect=1");
    expect(customerHref("priya+1@sharma.example")).toBe("/admin/customers?q=priya%2B1%40sharma.example");
    expect(licenseHref("LIC-24017")).toBe("/admin/licenses?id=LIC-24017");
  });

  it("sends only the changed fields from the status form", () => {
    const current = { status: "open" as const, priority: "normal" as const, assigneeId: null };
    expect(ticketMetaPatch(current, current)).toBeNull();
    expect(ticketMetaPatch(current, { ...current, priority: "high", assigneeId: "u1" })).toEqual({ priority: "high", assigneeId: "u1" });
    expect(ticketMetaPatch({ ...current, assigneeId: "u1" }, { ...current, assigneeId: null })).toEqual({ assigneeId: null });
  });
});

describe("request bodies", () => {
  it("needs 2+ characters for a reply or note, rejects control characters and unknown keys", () => {
    expect(staffMessageError(" a ", false)).toBe("Write a reply first.");
    expect(staffMessageError("a", true)).toBe("Write a note first.");
    expect(staffMessageError("ok", false)).toBeNull();
    expect(staffMessageError("bad\u0007bell", false)).toBe("Remove control characters from the text.");
    expect(staffMessageError("x".repeat(10_001), false)).toBe("Use 10,000 characters or fewer.");
    expect(staffMessageSchema.parse({ body: "Hi\r\nthere  ", internal: true })).toEqual({ body: "Hi\nthere", internal: true, attachmentIds: [] });
    expect(staffMessageSchema.safeParse({ body: "Hi", attachmentIds: ["a", "a"] }).success).toBe(false);
    expect(staffMessageSchema.safeParse({ body: "Hi", attachmentIds: ["1", "2", "3", "4", "5", "6"] }).success).toBe(false);
    expect(staffMessageSchema.safeParse({ body: "Hi", isStaff: false }).success).toBe(false);
  });

  it("PATCH needs at least one known field; bulk takes 1-100 distinct ticket ids", () => {
    expect(ticketPatchSchema.safeParse({}).success).toBe(false);
    expect(ticketPatchSchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(ticketPatchSchema.parse({ assigneeId: null })).toEqual({ assigneeId: null });
    expect(ticketPatchSchema.safeParse({ priority: "high", subject: "x" }).success).toBe(false);
    expect(ticketBulkSchema.safeParse({ action: "resolve", ids: [] }).success).toBe(false);
    expect(ticketBulkSchema.safeParse({ action: "resolve", ids: ["T-1", "T-1"] }).success).toBe(false);
    expect(ticketBulkSchema.safeParse({ action: "delete", ids: ["T-1"] }).success).toBe(false);
    expect(ticketBulkSchema.safeParse({ action: "assign_to_me", ids: ["LIC-1"] }).success).toBe(false);
    expect(ticketBulkSchema.parse({ action: "assign_to_me", ids: ["T-1", "T-2"] })).toEqual({ action: "assign_to_me", ids: ["T-1", "T-2"] });
  });
});
