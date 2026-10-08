/**
 * Portal shell model (components/account/portal-nav.ts): sidebar groups per team role, badges, the active item,
 * breadcrumbs, permission copy, the search/notification normalisers, and the middleware path header the portal
 * layout reads for its redirects.
 */
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  badgeLabel,
  breadcrumbTrail,
  devicesLabel,
  initialsOf,
  joinWithOr,
  locationsSummary,
  navGroupsFor,
  navKeyForPath,
  normalizeNotifications,
  normalizeSearchResponse,
  notificationsLabel,
  notificationVisual,
  PORTAL_NAV_GROUPS,
  relativeTime,
  safeInternalHref,
  teamAreaDeniedMessage,
  teamRequiresLabel,
  type PortalCounts,
} from "@/components/account/portal-nav";
import { TEAM_ROLES } from "@/lib/rbac";
import { middleware } from "@/middleware";

const NO_COUNTS: PortalCounts = { tickets: 0, notifications: 0, licensesNeedingAttention: 0 };
const keysFor = (role: (typeof TEAM_ROLES)[number]) => navGroupsFor(role, NO_COUNTS).flatMap((g) => g.items.map((i) => i.key));

describe("sidebar groups", () => {
  it("follow the prototype order, labels and icons", () => {
    expect(PORTAL_NAV_GROUPS.map((g) => g.label)).toEqual(["Workspace", "Licensing", "Billing", "Support", "Administration"]);
    const owner = navGroupsFor("OWNER", NO_COUNTS);
    expect(owner.map((g) => g.items.map((i) => `${i.label}:${i.icon}:${i.href}`))).toEqual([
      ["Overview:space_dashboard:/account", "Software & downloads:download:/account/software"],
      ["Licenses:key:/account/licenses", "Devices:devices:/account/devices"],
      ["Orders & invoices:receipt_long:/account/orders", "Billing & tax details:account_balance:/account/billing"],
      ["Tickets:support_agent:/account/tickets", "Notifications:notifications:/account/notifications"],
      ["Team & access:group:/account/team", "Activity log:history:/account/activity", "Security:shield_person:/account/security"],
    ]);
  });

  it("hide the owner-only pages (Team, Activity log) from every other role, never Security", () => {
    for (const role of TEAM_ROLES) {
      const keys = keysFor(role);
      expect(keys.includes("team"), role).toBe(role === "OWNER");
      expect(keys.includes("activity"), role).toBe(role === "OWNER");
      expect(keys).toContain("security");
      expect(keys).toContain("tickets");
      expect(keys).toContain("orders");
    }
    expect(keysFor("VIEWER")).toHaveLength(9);
  });

  it("show badges only above zero, with the prototype tones and screen-reader wording", () => {
    const groups = navGroupsFor("TECHNICAL", { tickets: 3, notifications: 0, licensesNeedingAttention: 1 });
    const items = Object.fromEntries(groups.flatMap((g) => g.items).map((i) => [i.key, i.badge]));
    expect(items.licenses).toEqual({ value: 1, tone: "warn", label: "1 needs attention" });
    expect(items.tickets).toEqual({ value: 3, tone: "primary", label: "3 open" });
    expect(items.notifications).toBeNull();
    expect(items.overview).toBeNull();
    expect(badgeLabel("licensesNeedingAttention", 2)).toBe("2 need attention");
    expect(badgeLabel("notifications", 4)).toBe("4 unread");
  });
});

describe("active item and breadcrumbs", () => {
  it("maps paths to their sidebar item (detail and new-ticket pages highlight the parent)", () => {
    expect(navKeyForPath("/account")).toBe("overview");
    expect(navKeyForPath("/account/")).toBe("overview");
    expect(navKeyForPath("/account?tab=x")).toBe("overview");
    expect(navKeyForPath("/account/licenses/LIC-24017")).toBe("licenses");
    expect(navKeyForPath("/account/tickets/new")).toBe("tickets");
    expect(navKeyForPath("/account/tickets/T-3018")).toBe("tickets");
    expect(navKeyForPath("/account/security")).toBe("security");
    expect(navKeyForPath("/account/overview")).toBeNull();
    expect(navKeyForPath("/account/unknown")).toBeNull();
    expect(navKeyForPath("/accounts")).toBeNull();
    expect(navKeyForPath("/admin")).toBeNull();
    expect(navKeyForPath(null)).toBeNull();
  });

  it("builds business / section / id trails like the prototype", () => {
    expect(breadcrumbTrail("/account", "Sharma Medicals")).toEqual([{ label: "Sharma Medicals", href: "/account" }]);
    expect(breadcrumbTrail("/account/licenses/LIC-24017", "Sharma Medicals")).toEqual([
      { label: "Sharma Medicals", href: "/account" },
      { label: "Licenses", href: "/account/licenses" },
      { label: "LIC-24017", href: "/account/licenses/LIC-24017" },
    ]);
    expect(breadcrumbTrail("/account/tickets/new", "Sharma Medicals").map((c) => c.label)).toEqual([
      "Sharma Medicals",
      "Tickets",
      "New ticket",
    ]);
    expect(breadcrumbTrail("/account/orders", "S").map((c) => c.label)).toEqual(["S", "Orders & invoices"]);
    expect(breadcrumbTrail("/account/tickets/T%20301", "S").at(-1)).toEqual({ label: "T 301", href: "/account/tickets/T%20301" });
    expect(breadcrumbTrail("/account/nope", "")).toEqual([{ label: "Account", href: "/account" }]);
  });
});

describe("permission copy", () => {
  it("names the roles that hold a permission", () => {
    expect(teamRequiresLabel("keys.reveal")).toBe("Requires Owner or Technical contact");
    expect(teamRequiresLabel("purchases")).toBe("Requires Owner or Billing admin");
    expect(teamRequiresLabel("tickets.create")).toBe("Requires Owner, Billing admin or Technical contact");
    expect(teamRequiresLabel("team.manage")).toBe("Requires Owner");
    expect(joinWithOr([])).toBe("");
  });

  it("explains a denied page with the member's role", () => {
    expect(teamAreaDeniedMessage("activity.view", "BILLING")).toBe(
      "This area needs Owner access. You\u2019re signed in as Billing admin. Ask the account owner if you need it.",
    );
  });
});

describe("shell labels", () => {
  it("formats initials, counts and relative times", () => {
    expect(initialsOf("Sharma Medicals")).toBe("SM");
    expect(initialsOf("  priya  ")).toBe("P");
    expect(initialsOf("Joshi Medical & Co")).toBe("JM");
    expect(initialsOf("")).toBe("?");
    expect(locationsSummary(2)).toBe("Business \u00b7 2 locations");
    expect(locationsSummary(1)).toBe("Business \u00b7 1 location");
    expect(devicesLabel(1)).toBe("1 device");
    expect(devicesLabel(0)).toBe("0 devices");
    expect(notificationsLabel(3)).toBe("Notifications, 3 unread");
    const now = new Date("2026-10-07T12:00:00.000Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(relativeTime(ago(10 * 60_000), now)).toBe("just now");
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe("3h ago");
    expect(relativeTime(ago(30 * 3_600_000), now)).toBe("yesterday");
    expect(relativeTime(ago(12 * 86_400_000), now)).toBe("12d ago");
    expect(relativeTime(new Date("2026-08-01T06:00:00.000Z"), now)).toBe("1 Aug 2026");
  });

  it("maps notification kinds to icons and tones (security has its own)", () => {
    expect(notificationVisual("renewal")).toEqual({ icon: "event_upcoming", tone: "peach" });
    expect(notificationVisual("security")).toEqual({ icon: "shield", tone: "pink" });
    expect(notificationVisual("other")).toEqual({ icon: "notifications", tone: "lavender" });
  });
});

describe("search results", () => {
  it("reads the grouped form, in license / device / order / ticket order, building prototype titles and links", () => {
    const rows = normalizeSearchResponse({
      tickets: [{ id: "T-3018", subject: "Barcode scanner stops working" }],
      orders: [{ id: "AX-10301", invoiceNumber: "AXS/26-27/1175", totalPaise: 589_882 }, { id: "AX-10400", totalPaise: 499_900 }],
      devices: [{ id: "d1", name: "Billing counter PC", licenseId: "LIC-24017", os: "Windows 11 Pro", active: false }],
      licenses: [{ id: "LIC-24017", productShortName: "Medical Store Billing", planName: "Annual license", productCode: "MED", keyLast4: "K8NM" }],
    });
    expect(rows.map((r) => [r.kind, r.title, r.subtitle, r.href, r.fullPageLoad])).toEqual([
      ["license", "LIC-24017 \u00b7 Medical Store Billing", "Annual license \u00b7 MED-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-K8NM", "/account/licenses/LIC-24017", false],
      ["device", "Billing counter PC", "LIC-24017 \u00b7 Windows 11 Pro \u00b7 deactivated", "/account/licenses/LIC-24017?tab=devices", false],
      ["order", "AX-10301", "AXS/26-27/1175 \u00b7 \u20b95,898.82", "/orders/AX-10301", true],
      ["order", "AX-10400", "No invoice \u00b7 \u20b94,999", "/orders/AX-10400", true],
      ["ticket", "T-3018", "Barcode scanner stops working", "/account/tickets/T-3018", false],
    ]);
  });

  it("reads the flat form and keeps API titles, refusing links to other origins", () => {
    const rows = normalizeSearchResponse({
      results: [
        { type: "TICKET", id: "T-1", title: "T-1", subtitle: "Printer", href: "/account/tickets/T-1" },
        { type: "license", id: "LIC-1", title: "LIC-1 \u00b7 Cheque", subtitle: "One-time", href: "https://evil.example/x" },
        { type: "unknown", id: "x" },
        { type: "order", title: "missing id" },
      ],
    });
    expect(rows.map((r) => [r.kind, r.title, r.href])).toEqual([
      ["license", "LIC-1 \u00b7 Cheque", "/account/licenses/LIC-1"],
      ["ticket", "T-1", "/account/tickets/T-1"],
    ]);
    expect(normalizeSearchResponse(null)).toEqual([]);
    expect(normalizeSearchResponse({ groups: { licenses: [{ id: "LIC-9", keyMasked: "CHQ-\u2022\u2022\u2022\u2022-9" }] } })[0]?.subtitle).toBe(
      "CHQ-\u2022\u2022\u2022\u2022-9",
    );
  });

  it("caps the list at 20 rows", () => {
    const licenses = Array.from({ length: 30 }, (_, i) => ({ id: `LIC-${i}` }));
    expect(normalizeSearchResponse({ licenses })).toHaveLength(20);
  });

  it("only keeps same-origin paths", () => {
    expect(safeInternalHref("/account/x")).toBe("/account/x");
    for (const bad of ["//evil.example", "https://evil.example", "javascript:alert(1)", "/\\evil.example", "", 5]) {
      expect(safeInternalHref(bad)).toBeNull();
    }
  });
});

describe("notification menu rows", () => {
  it("normalises rows, read state and the unread count", () => {
    const { items, unread } = normalizeNotifications({
      notifications: [
        { id: "n1", kind: "Ticket", title: "Support replied", body: "See T-1", href: "/account/tickets/T-1", readAt: null, createdAt: "2026-10-07T04:00:00.000Z" },
        { id: "n2", kind: "renewal", title: "Renew", body: "", href: "https://evil.example", read: true, createdAt: "bad" },
        { title: "no id" },
      ],
      unread: 1,
    });
    expect(unread).toBe(1);
    expect(items).toEqual([
      { id: "n1", kind: "ticket", title: "Support replied", body: "See T-1", href: "/account/tickets/T-1", read: false, createdAt: new Date("2026-10-07T04:00:00.000Z") },
      { id: "n2", kind: "renewal", title: "Renew", body: "", href: null, read: true, createdAt: null },
    ]);
    expect(normalizeNotifications({ items: [] })).toEqual({ items: [], unread: null });
  });
});

describe("middleware path header", () => {
  it("forwards the requested portal path to the server, overwriting any client value", async () => {
    const req = new NextRequest("http://localhost:3000/account/licenses?status=active", {
      headers: { cookie: "axs_session=opaque-token", "x-axs-path": "//evil.example" },
    });
    const res = await middleware(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-request-x-axs-path")).toBe("/account/licenses?status=active");
  });
});
