/**
 * Regressions for the Phase 6 admin fidelity review (fix-UI): selection reset on filter changes, first sort direction,
 * page titles, phone cards, export tooltips, the tickets stats row, the EXPIRES colour, the audit card and the staff
 * invitation brand panel. Unit tests cannot import .tsx here (tsconfig jsx: preserve), so the rules live in .ts
 * modules, and two source checks cover the .tsx call sites.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMIN_CARD_CLASSES } from "@/components/admin/admin-card-classes";
import { adminPageMetadata, adminTitle } from "@/components/admin/admin-nav";
import type { AdminTableProps } from "@/components/admin/admin-table";
import { canExport, exportNeedsAllLabel, withSelectionReset } from "@/components/admin/admin-table-model";
import { auditCardText } from "@/components/admin/audit/card-text";
import { expiresSoon } from "@/components/admin/licenses/expires";
import { STAFF_INVITE_ASIDE } from "@/components/admin/staff/staff-invite-model";
import { ticketStatsRow } from "@/components/admin/tickets/stats";
import { AUTH_ASIDE } from "@/components/auth/copy";
import { columnSortsDescFirst } from "@/components/data-table/model";
import type { DataTableToolbar } from "@/components/data-table/types";
import type { StaffRole } from "@/generated/prisma/enums";
import { can, type Permission } from "@/lib/rbac";

const SUFFIX = "Admin \u2014 Axiomatic Software Solutions";
const ADMIN_DIR = fileURLToPath(new URL("../../components/admin/", import.meta.url));

function adminSources(dir = ADMIN_DIR): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return adminSources(full);
    return entry.name.endsWith(".tsx") ? [{ file: full.slice(ADMIN_DIR.length), text: readFileSync(full, "utf8") }] : [];
  });
}

/** Source of `export function name(...) { ... }` up to its closing brace at column 0. */
function functionSource(relativeFile: string, name: string): string {
  const text = readFileSync(join(ADMIN_DIR, relativeFile), "utf8");
  const start = text.indexOf(`export function ${name}(`);
  expect(start, `${relativeFile} exports ${name}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end + 2);
}

describe("bulk selection follows the filters (prototype: a filter change clears `sel`)", () => {
  function toolbar(calls: string[]): DataTableToolbar<unknown> {
    return {
      search: { value: "", onChange: (v) => calls.push(`search=${v}`), placeholder: "Search" },
      filters: [
        { id: "status", label: "Status", options: [], value: "all", onChange: (v) => calls.push(`status=${v}`) },
        { id: "method", label: "Method", options: [], value: "all", onChange: (v) => calls.push(`method=${v}`) },
      ],
      onClear: () => calls.push("clear"),
    };
  }

  it("clears the selection before every filter change and Clear", () => {
    const calls: string[] = [];
    const wrapped = withSelectionReset(toolbar(calls), () => calls.push("reset"));
    wrapped.filters?.[0]?.onChange("failed");
    wrapped.filters?.[1]?.onChange("upi");
    wrapped.onClear?.();
    expect(calls).toEqual(["reset", "status=failed", "reset", "method=upi", "reset", "clear"]);
  });

  it("keeps the selection for search (as the prototype does)", () => {
    const calls: string[] = [];
    withSelectionReset(toolbar(calls), () => calls.push("reset")).search?.onChange("AX-10425");
    expect(calls).toEqual(["search=AX-10425"]);
  });

  it("leaves toolbars without filters or Clear as they are", () => {
    expect(withSelectionReset<unknown>({ countLabel: "3 results" }, () => undefined)).toEqual({ countLabel: "3 results" });
  });
});

describe("first sort direction (prototype: `c.align === 'right' ? -1 : 1`)", () => {
  it("starts right-aligned columns descending and the rest ascending; a column's own setting wins", () => {
    expect(columnSortsDescFirst({ meta: { align: "right" } })).toBe(true);
    expect(columnSortsDescFirst({})).toBe(false);
    expect(columnSortsDescFirst({ meta: { align: "left" } })).toBe(false);
    expect(columnSortsDescFirst({ sortDescFirst: false, meta: { align: "right" } })).toBe(false);
    expect(columnSortsDescFirst({}, true)).toBe(true);
  });

  it("AdminTable takes no table-level sortDescFirst", () => {
    type HasTableSortDescFirst = "sortDescFirst" extends keyof AdminTableProps<unknown> ? true : false;
    const hasIt: HasTableSortDescFirst = false;
    expect(hasIt).toBe(false);
  });

  it("no admin column opts a text or date column into descending first", () => {
    const offenders = adminSources()
      .filter(({ text }) => /^\s*sortDescFirst(\s*[:=]|\s*$)/m.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

describe("admin page titles", () => {
  it("are absolute, so /admin and not-found (in the layout's own segment) get the admin suffix too", () => {
    expect(adminPageMetadata("overview").title).toEqual({ absolute: `Overview \u00b7 ${SUFFIX}` });
    expect(adminTitle("Page not found")).toEqual({ absolute: `Page not found \u00b7 ${SUFFIX}` });
  });
});

describe("admin phone cards (prototype: title 14px/800 + badge, subtitle 12.5px/600)", () => {
  it("AdminCardContent uses the prototype sizes, in the body font", () => {
    expect(ADMIN_CARD_CLASSES.title).toContain("text-[14px] font-extrabold");
    expect(ADMIN_CARD_CLASSES.subtitle).toContain("text-[12.5px] font-semibold text-ink-2");
    expect(ADMIN_CARD_CLASSES.root).toContain("gap-1.5");
    expect(Object.values(ADMIN_CARD_CLASSES).join(" ")).not.toContain("font-mono");
  });

  it.each([
    ["orders/order-columns.tsx", "orderCard"],
    ["customers/customer-columns.tsx", "customerCard"],
    ["licenses/license-columns.tsx", "licenseCard"],
    ["renewals/renewal-columns.tsx", "renewalCard"],
    ["coupons/coupon-columns.tsx", "couponCard"],
    ["content/faq-columns.tsx", "faqCard"],
    ["templates/template-columns.tsx", "templateCard"],
    ["leads/lead-columns.tsx", "leadCard"],
    ["audit/audit-card.tsx", "auditCard"],
  ])("%s %s renders AdminCardContent without sizes of its own", (file, name) => {
    const source = functionSource(file, name);
    expect(source).toContain("<AdminCardContent");
    expect(source).not.toMatch(/text-\[\d/);
  });

  it("order and coupon card titles are not mono", () => {
    expect(functionSource("orders/order-columns.tsx", "orderCard")).not.toContain("font-mono");
    expect(functionSource("coupons/coupon-columns.tsx", "couponCard")).not.toContain("font-mono");
  });

  it("audit card: '{actor} · {action}', '{target} · {relative}' and the role", () => {
    const row = { actorName: "Vikram Rao", action: "Extended license", target: "LIC-24188", at: "2026-10-04T12:00:00.000Z", actorRole: "admin" };
    expect(auditCardText(row, "2026-10-07T12:00:00.000Z")).toEqual({
      title: "Vikram Rao \u00B7 Extended license",
      subtitle: "LIC-24188 \u00B7 3d ago",
      role: "Administrator",
    });
    expect(auditCardText({ ...row, actorRole: "system", actorName: "System" }, "2026-10-04T12:20:00.000Z").subtitle).toBe("LIC-24188 \u00B7 20m ago");
  });
});

describe("CSV export permission", () => {
  it("names only the roles that hold every permission the export needs", () => {
    expect(exportNeedsAllLabel("reports.export")).toBe("Export needs Owner / Finance");
    expect(exportNeedsAllLabel("audit.view")).toBe("Export needs Owner / Administrator");
    expect(exportNeedsAllLabel(["reports.export", "content.manage"])).toBe("Export needs Owner");
    expect(exportNeedsAllLabel(["reports.export", "templates.manage"])).toBe("Export needs Owner");
    expect(exportNeedsAllLabel(["reports.export", "leads.view"])).toBe("Export needs Owner");
  });

  it("gates on all of them", () => {
    const allows = (role: StaffRole) => (perm: Permission) => can(role, perm);
    expect(canExport(["reports.export", "content.manage"], allows("OWNER"))).toBe(true);
    expect(canExport(["reports.export", "content.manage"], allows("ADMIN"))).toBe(false);
    expect(canExport(["reports.export", "leads.view"], allows("FINANCE"))).toBe(false);
    expect(canExport(["reports.export", "leads.view"], allows("SUPPORT"))).toBe(false);
    expect(canExport("reports.export", allows("FINANCE"))).toBe(true);
  });

  it("FAQ, template and lead tables pass both permissions, as their export routes require", () => {
    const perms = (file: string) => /exportPerm=\{?(.+?)\}?\n/.exec(readFileSync(join(ADMIN_DIR, file), "utf8"))?.[1];
    expect(perms("content/faqs-view.tsx")).toBe('["reports.export", "content.manage"]');
    expect(perms("templates/templates-view.tsx")).toBe('["reports.export", "templates.manage"]');
    expect(perms("leads/leads-view.tsx")).toBe('["reports.export", "leads.view"]');
    expect(perms("staff/staff-view.tsx")).toBe('"staff.manage"');
  });
});

describe("tickets stats row", () => {
  it("shows the prototype's Open, Unassigned, High priority and Resolved, then First response", () => {
    const row = ticketStatsRow({ open: 3, unassigned: 2, highPriority: 1, resolved: 1204, firstResponseMedianMs: null, firstResponseSample: 0 });
    expect(row.map((s) => [s.label, s.value, s.tone])).toEqual([
      ["Open", "3", "blue"],
      ["Unassigned", "2", "peach"],
      ["High priority", "1", "pink"],
      ["Resolved", "1,204", "sage"],
      ["First response", "\u2014", "lavender"],
    ]);
  });
});

describe("licenses EXPIRES colour (prototype: any end date within 60 days, whatever the status)", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  it("is amber for dates within the window or past, ink after it", () => {
    expect(expiresSoon("2026-10-22T12:00:00.000Z", now)).toBe(true);
    expect(expiresSoon("2026-09-01T12:00:00.000Z", now)).toBe(true);
    expect(expiresSoon("2026-12-06T11:59:59.000Z", now)).toBe(true);
    expect(expiresSoon("2026-12-06T12:00:00.000Z", now)).toBe(false);
    expect(expiresSoon("2027-10-07T12:00:00.000Z", now)).toBe(false);
  });
});

describe("staff invitation brand panel", () => {
  it("has staff copy instead of the customer portal's", () => {
    expect(STAFF_INVITE_ASIDE.headline).not.toBe(AUTH_ASIDE.headline);
    expect(STAFF_INVITE_ASIDE.bullets.map((b) => b.text)).not.toEqual(AUTH_ASIDE.bullets.map((b) => b.text));
    expect(new Set(STAFF_INVITE_ASIDE.bullets.map((b) => b.icon)).size).toBe(STAFF_INVITE_ASIDE.bullets.length);
  });
});
