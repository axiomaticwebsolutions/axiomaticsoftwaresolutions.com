/**
 * Admin shell model (components/admin/admin-nav.ts, components/admin/model.ts): module routes, the sidebar locks per
 * role (Admin Console.dc.html role views), badges, module search, breadcrumbs, status badges, the facts grid layout
 * and drawer URL parameters.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_HOME,
  adminBreadcrumb,
  adminNavGroups,
  adminPageMetadata,
  adminPathFrom,
  badgeLabel,
  badgeText,
  initialsOf,
  moduleHref,
  moduleKeyForPath,
  moduleViewsFor,
  searchModules,
} from "@/components/admin/admin-nav";
import { fieldGridLayout, humanizeStatus, STATUS_META, statusMeta, withParam } from "@/components/admin/model";
import type { StaffRole } from "@/generated/prisma/enums";
import { ADMIN_MODULE_GROUPS, ADMIN_MODULES, type AdminModuleKey } from "@/lib/rbac";

const locked = (role: StaffRole) =>
  moduleViewsFor(role)
    .filter((m) => m.locked)
    .map((m) => m.key);

describe("module routes", () => {
  it("put the overview at /admin and every other module at /admin/<key>", () => {
    expect(moduleHref("overview")).toBe("/admin");
    expect(moduleHref("orders")).toBe("/admin/orders");
    for (const m of ADMIN_MODULES) expect(moduleKeyForPath(moduleHref(m.key))).toBe(m.key);
  });

  it("find the module of nested paths and ignore everything else", () => {
    expect(moduleKeyForPath("/admin/")).toBe("overview");
    expect(moduleKeyForPath("/admin/orders/AX-10262")).toBe("orders");
    expect(moduleKeyForPath("/admin/licenses?id=LIC-24017")).toBe("licenses");
    for (const other of [null, undefined, "", "/", "/account", "/administrator", "/admin/overview", "/admin/nope", "/adminx/orders"]) {
      expect(moduleKeyForPath(other)).toBeNull();
    }
  });

  it("keep only safe admin paths from the middleware header", () => {
    expect(adminPathFrom("/admin/orders?filter%5Bstatus%5D=paid")).toBe("/admin/orders?filter%5Bstatus%5D=paid");
    expect(adminPathFrom("/admin")).toBe("/admin");
    for (const bad of [null, "", "//evil.example/admin", "https://evil.example/admin", "/account", "/administrator", "/api/admin/orders", "/admin\\evil.example"]) {
      expect(adminPathFrom(bad)).toBe(ADMIN_HOME);
    }
  });
});

describe("sidebar locks per role (prototype role views)", () => {
  it("lock nothing for the Owner", () => {
    expect(locked("OWNER")).toEqual([]);
  });

  it("lock Staff & roles and Settings for an Administrator", () => {
    expect(locked("ADMIN")).toEqual(["staff", "settings"]);
  });

  it("lock content, templates, reports, staff, audit and settings for Support", () => {
    expect(locked("SUPPORT")).toEqual(["content", "templates", "reports", "staff", "audit", "settings"]);
  });

  it("lock tickets, leads, content, templates, staff, audit and settings for Finance", () => {
    expect(locked("FINANCE")).toEqual(["tickets", "leads", "content", "templates", "staff", "audit", "settings"]);
  });

  it("keep every module in sidebar order with its href", () => {
    const views = moduleViewsFor("SUPPORT");
    expect(views.map((m) => m.key)).toEqual(ADMIN_MODULES.map((m) => m.key));
    expect(views.every((m) => m.href === moduleHref(m.key))).toBe(true);
  });
});

describe("badges", () => {
  it("show counts only on modules the role can open, as whole non-negative numbers", () => {
    const views = moduleViewsFor("FINANCE", { orders: 3, tickets: 2, leads: 5, settings: 9 });
    const badge = (key: AdminModuleKey) => views.find((m) => m.key === key)?.badge;
    expect(badge("orders")).toBe(3);
    expect(badge("tickets")).toBe(0);
    expect(badge("leads")).toBe(0);
    expect(badge("settings")).toBe(0);
    expect(badge("products")).toBe(0);
    const odd = moduleViewsFor("OWNER", { orders: -1, tickets: Number.NaN, leads: 2.7 });
    expect(odd.find((m) => m.key === "orders")?.badge).toBe(0);
    expect(odd.find((m) => m.key === "tickets")?.badge).toBe(0);
    expect(odd.find((m) => m.key === "leads")?.badge).toBe(2);
  });

  it("read as text for screen readers and cap the visible number", () => {
    expect(badgeLabel("orders", 3)).toBe("3 pending or in review");
    expect(badgeLabel("tickets", 1)).toBe("1 open and unassigned");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(100)).toBe("99+");
  });
});

describe("nav groups", () => {
  it("follow the rbac group order and contain every module once", () => {
    const groups = adminNavGroups(moduleViewsFor("OWNER"));
    expect(groups.map((g) => g.group)).toEqual(ADMIN_MODULE_GROUPS.filter((g) => ADMIN_MODULES.some((m) => m.group === g)));
    expect(groups.flatMap((g) => g.items.map((m) => m.key))).toEqual(ADMIN_MODULES.map((m) => m.key));
    expect(groups.find((g) => g.group === "SUPPORT")?.items.map((m) => m.key)).toEqual(["tickets", "leads"]);
    expect(groups.find((g) => g.group === "SALES")?.items.map((m) => m.label)).toEqual(["Orders & payments", "Customers", "Coupons", "Renewals"]);
  });
});

describe("module search", () => {
  const modules = moduleViewsFor("SUPPORT");
  const keys = (q: string) => searchModules(modules, q).map((m) => m.key);

  it("lists every module for an empty query", () => {
    expect(keys("")).toEqual(ADMIN_MODULES.map((m) => m.key));
    expect(keys("   ")).toHaveLength(ADMIN_MODULES.length);
  });

  it("matches names before descriptions, best match first", () => {
    expect(keys("ord")).toEqual(["orders"]);
    expect(keys("lic")[0]).toBe("licenses");
    expect(keys("lic")).toContain("plans"); // "Plans & license policies"
    expect(keys("Plans & pricing")).toEqual(["plans"]);
    expect(keys("AUDIT")).toEqual(["audit"]);
    expect(keys("sales")).toEqual(["orders", "customers", "coupons", "renewals"]);
    expect(keys("pay ord")).toEqual(["orders"]);
  });

  it("falls back to descriptions and keeps locked modules", () => {
    expect(keys("webhook")).toEqual(["orders"]);
    expect(keys("settings")).toEqual(["settings"]);
    expect(searchModules(modules, "settings")[0]?.locked).toBe(true);
    expect(keys("zzzz")).toEqual([]);
  });
});

describe("page frame helpers", () => {
  it("build the prototype breadcrumb and page metadata", () => {
    expect(adminBreadcrumb({ group: "SALES", title: "Orders, payments & refunds" })).toEqual(["Admin", "Sales", "Orders, payments & refunds"]);
    // Absolute titles: the layout's template does not reach pages in its own segment (/admin overview).
    expect(adminPageMetadata("orders")).toEqual({
      title: { absolute: "Orders, payments & refunds \u00b7 Admin \u2014 Axiomatic Software Solutions" },
      robots: { index: false, follow: false },
    });
    expect(adminPageMetadata("overview").title).toEqual({ absolute: "Overview \u00b7 Admin \u2014 Axiomatic Software Solutions" });
    expect(adminPageMetadata("orders", "AX-10262").title).toEqual({ absolute: "AX-10262 \u00b7 Admin \u2014 Axiomatic Software Solutions" });
  });

  it("derive avatar initials", () => {
    expect(initialsOf("Vikram Rao")).toBe("VR");
    expect(initialsOf("  sneha   anil patil ")).toBe("SP");
    expect(initialsOf("Karan")).toBe("KA");
    expect(initialsOf("")).toBe("?");
  });
});

describe("status badges", () => {
  it("map Prisma enum values and derived statuses to the prototype labels and tones", () => {
    expect(statusMeta("order", "PAID")).toEqual({ label: "Paid", tone: "sage" });
    expect(statusMeta("order", "REVIEW")).toEqual({ label: "In review", tone: "peach" });
    expect(statusMeta("order", "PARTIALLY_REFUNDED")).toEqual({ label: "Partly refunded", tone: "lavender" });
    expect(statusMeta("license", "expiring")).toEqual({ label: "Expiring", tone: "peach" });
    expect(statusMeta("license", "revoked")).toEqual({ label: "Revoked", tone: "pink" });
    expect(statusMeta("ticket", "AWAITING_CUSTOMER")).toEqual({ label: "Awaiting customer", tone: "peach" });
    expect(statusMeta("coupon", "scheduled")).toEqual({ label: "Scheduled", tone: "blue" });
    expect(statusMeta("staff", "INVITED")).toEqual({ label: "Invited", tone: "peach" });
    expect(statusMeta("role", "ADMIN")).toEqual({ label: "Administrator", tone: "blue" });
    expect(statusMeta("release", "latest")).toEqual({ label: "Latest", tone: "sage" });
  });

  it("fall back to a readable slate badge for unknown statuses", () => {
    expect(statusMeta("order", "ON_HOLD")).toEqual({ label: "On hold", tone: "slate" });
    expect(statusMeta("ticket", null)).toEqual({ label: "\u2014", tone: "slate" });
    expect(humanizeStatus("awaiting-customer")).toBe("Awaiting customer");
  });

  it("only use the prototype tones", () => {
    const tones = new Set(["sage", "peach", "pink", "lavender", "blue", "slate"]);
    for (const map of Object.values(STATUS_META)) {
      for (const meta of Object.values(map) as { tone: string; label: string }[]) {
        expect(tones.has(meta.tone)).toBe(true);
        expect(meta.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("facts grid layout", () => {
  it("drops the right border in the right column and the bottom border on the last row", () => {
    expect(fieldGridLayout([{}, {}, {}, {}])).toEqual([
      { right: false, lastRow: false },
      { right: true, lastRow: false },
      { right: false, lastRow: true },
      { right: true, lastRow: true },
    ]);
    expect(fieldGridLayout([{}, {}, {}])).toEqual([
      { right: false, lastRow: false },
      { right: true, lastRow: false },
      { right: false, lastRow: true },
    ]);
  });

  it("gives wide fields their own row", () => {
    expect(fieldGridLayout([{}, { wide: true }, {}, {}])).toEqual([
      { right: false, lastRow: false },
      { right: true, lastRow: false },
      { right: false, lastRow: true },
      { right: true, lastRow: true },
    ]);
    expect(fieldGridLayout([{ wide: true }])).toEqual([{ right: true, lastRow: true }]);
    expect(fieldGridLayout([])).toEqual([]);
  });
});

describe("drawer URL parameter", () => {
  it("sets, replaces and removes the id while keeping list state", () => {
    expect(withParam("", "id", "AX-10262")).toBe("?id=AX-10262");
    expect(withParam("?q=sharma&page=2", "id", "AX-1")).toBe("?q=sharma&page=2&id=AX-1");
    expect(withParam("?id=AX-1&sort=-date", "id", "AX-2")).toBe("?id=AX-2&sort=-date");
    expect(withParam("?id=AX-1&sort=-date", "id", null)).toBe("?sort=-date");
    expect(withParam("?id=AX-1", "id", null)).toBe("");
    expect(withParam("", "id", "LIC 1&x")).toBe("?id=LIC+1%26x");
  });
});
