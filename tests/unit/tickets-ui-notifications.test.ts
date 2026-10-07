import { describe, expect, it } from "vitest";
import {
  appendPage,
  emailPrefRows,
  isPortalHref,
  markItemsRead,
  notificationsHref,
  offersConsentNote,
  parseNotificationFilter,
  unreadTabLabel,
  visibleNotifications,
  type NotificationItem,
} from "@/components/account/notifications/model";

const n = (id: string, read: boolean, readAt: string | null = read ? "2026-09-01T00:00:00.000Z" : null): NotificationItem => ({
  id,
  kind: "ticket",
  title: `Title ${id}`,
  body: "",
  href: null,
  read,
  readAt,
  createdAt: "2026-10-01T00:00:00.000Z",
});

describe("notifications filter", () => {
  it("reads ?filter= and keeps All out of the URL", () => {
    expect(parseNotificationFilter("unread")).toBe("unread");
    expect(parseNotificationFilter("bogus")).toBe("all");
    expect(parseNotificationFilter(undefined)).toBe("all");
    expect(notificationsHref("unread")).toBe("/account/notifications?filter=unread");
    expect(notificationsHref("all")).toBe("/account/notifications");
    expect(unreadTabLabel(2)).toBe("Unread (2)");
  });

  it("hides notifications read on the page from the Unread tab", () => {
    const items = [n("a", false), n("b", true)];
    expect(visibleNotifications(items, "unread").map((x) => x.id)).toEqual(["a"]);
    expect(visibleNotifications(items, "all").map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("notification read state", () => {
  it("marks the given ids, or every unread one, keeping earlier read times", () => {
    const items = [n("a", false), n("b", true), n("c", false)];
    const one = markItemsRead(items, ["a", "zzz"], "2026-10-07T10:00:00.000Z");
    expect(one.map((x) => [x.id, x.read, x.readAt])).toEqual([
      ["a", true, "2026-10-07T10:00:00.000Z"],
      ["b", true, "2026-09-01T00:00:00.000Z"],
      ["c", false, null],
    ]);
    const all = markItemsRead(items, undefined, "2026-10-07T10:00:00.000Z");
    expect(all.every((x) => x.read)).toBe(true);
    expect(all[1]?.readAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("appends further pages without duplicates", () => {
    expect(appendPage([n("a", false), n("b", true)], [n("b", true), n("c", false)]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("navigates portal links in the app and loads other pages in full", () => {
    expect(isPortalHref("/account/tickets/T-3018")).toBe(true);
    expect(isPortalHref("/account")).toBe(true);
    expect(isPortalHref("/orders/AX-10386")).toBe(false);
    expect(isPortalHref("/accounting")).toBe(false);
  });
});

describe("email preferences", () => {
  it("lists the four switches in prototype order", () => {
    const rows = emailPrefRows({ renewals: true, updates: true, tickets: false, offers: false, offersConsentAt: null });
    expect(rows.map((r) => [r.label, r.on])).toEqual([
      ["Renewal reminders", true],
      ["New versions & release notes", true],
      ["Ticket replies", false],
      ["Offers & announcements", false],
    ]);
    expect(rows.slice(0, 3).every((r) => r.note === null)).toBe(true);
    expect(rows[3]?.note).toBe("Product news and occasional offers. Turning this on records your consent.");
  });

  it("shows when consent to offers was given (IST date)", () => {
    const rows = emailPrefRows({ renewals: true, updates: true, tickets: true, offers: true, offersConsentAt: "2026-10-06T20:00:00.000Z" });
    expect(rows[3]?.note).toBe("You agreed to these emails on 7 Oct 2026. You can turn them off at any time.");
    expect(offersConsentNote("not a date")).toBe("Product news and occasional offers. Turning this on records your consent.");
  });
});
