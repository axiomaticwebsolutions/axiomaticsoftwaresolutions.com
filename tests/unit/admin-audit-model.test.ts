import { describe, expect, it } from "vitest";
import { dispositionFileName } from "@/components/admin/audit/download";
import { formatAdminDateTime, formatAdminDateTimeLong, isoDateIST, relativeAgo } from "@/lib/admin/audit/format";
import {
  actionSlug,
  AUDIT_CSV_COLUMNS,
  AUDIT_LIST_SPEC,
  AUDIT_LIST_STATE,
  auditDetailText,
  auditExportDetail,
  auditRoleLabel,
  maskIp,
  parseAuditDate,
  targetHref,
  targetTypeLabel,
  type AuditRow,
} from "@/lib/admin/audit/model";
import { drawerIdParam, toUrlSearchParams } from "@/lib/admin/audit/params";
import { parseListQuery } from "@/lib/admin/list-query";
import { listStateToParams, parseListState } from "@/lib/url-state";

const row: AuditRow = {
  id: "evt1",
  at: "2026-10-06T14:22:00.000Z",
  actorId: "u1",
  actorName: "Vikram Rao",
  actorRole: "admin",
  action: "Changed plan price",
  target: "Medical Store Billing \u00B7 Annual license",
  targetType: "plan",
  targetId: "plan_1",
  reason: "Festive pricing",
  detail: "Rs 4,499 \u2192 Rs 4,999",
  ipPrefix: "103.21.66.x",
};

describe("audit model", () => {
  it("formats like the prototype, in IST", () => {
    expect(formatAdminDateTime("2026-10-06T14:22:00.000Z")).toBe("6 Oct, 7:52 pm");
    expect(formatAdminDateTimeLong("2026-10-05T18:40:00.000Z")).toBe("6 Oct 2026, 12:10 am");
    expect(formatAdminDateTime(null)).toBe("\u2014");
    const now = "2026-10-07T10:00:00.000Z";
    expect(["2026-10-07T09:59:40.000Z", "2026-10-07T09:48:00.000Z", "2026-10-06T17:00:00.000Z", "2026-10-04T10:00:00.000Z"].map((d) => relativeAgo(d, now))).toEqual([
      "just now",
      "12m ago",
      "17h ago",
      "3d ago",
    ]);
    expect(relativeAgo("2026-08-01T10:00:00.000Z", now)).toBe("1 Aug 2026");
    expect(isoDateIST("2026-10-06T19:00:00.000Z")).toBe("2026-10-07");
  });

  it("slugs actions and validates dates for the URL", () => {
    expect(actionSlug("Changed staff role")).toBe("changed-staff-role");
    expect(actionSlug("Extended license +30 days")).toBe("extended-license-30-days");
    expect(actionSlug("  ·  ")).toBe("");
    expect(parseAuditDate("2026-02-28")).toBe("2026-02-28");
    expect(parseAuditDate("2026-02-29")).toBeUndefined();
    expect(parseAuditDate("26-02-01")).toBeUndefined();
  });

  it("parses the list query leniently, like the page URL", () => {
    const q = parseListQuery(
      "q=refund&filter[role]=finance&filter[action]=issued-refund&filter[targetType]=order&filter[from]=2026-09-01&filter[to]=2026-13-01&filter[actor]=bad id&sort=action",
      AUDIT_LIST_SPEC,
    );
    expect(q.filters).toEqual({ role: "finance", action: "issued-refund", targetType: "order", from: "2026-09-01" });
    expect(q.sort).toEqual({ id: "action", desc: false });
    expect(parseListQuery("", AUDIT_LIST_SPEC)).toMatchObject({ sort: { id: "createdAt", desc: true }, pageSize: 25 });
    const state = parseListState(new URLSearchParams("filter[role]=system&filter[from]=2026-09-01&sort=-createdAt"), AUDIT_LIST_STATE);
    expect(state.filters.role).toBe("system");
    expect(listStateToParams(state, AUDIT_LIST_STATE).toString()).toBe("filter%5Brole%5D=system&filter%5Bfrom%5D=2026-09-01");
  });

  it("shows actors, targets, IPs and details", () => {
    expect(["admin", "system", "owner", "robot", ""].map(auditRoleLabel)).toEqual(["Administrator", "System", "Owner", "Robot", "\u2014"]);
    expect(maskIp("103.21.44.x")).toBe("103.21.44.\u2022\u2022\u2022");
    expect(maskIp("2001:db8:85a3::/48")).toBe("2001:db8:85a3::/48");
    expect(maskIp(null)).toBe("\u2014");
    expect(auditDetailText(row)).toBe("Rs 4,499 \u2192 Rs 4,999 \u00B7 Festive pricing");
    expect(auditDetailText({ detail: null, reason: " " })).toBe("\u2014");
    expect(targetTypeLabel("credit_note")).toBe("Credit note");
    expect(targetHref({ targetType: "order", targetId: "AX-10288" })).toEqual({ module: "orders", href: "/admin/orders?id=AX-10288" });
    // Customer rows carry the business account id (admin records): they open the customer drawer.
    expect(targetHref({ targetType: "customer", targetId: "cmacct123" })).toEqual({ module: "customers", href: "/admin/customers?id=cmacct123" });
    expect(targetHref({ targetType: "plan", targetId: "plan_1" })).toBeNull();
    expect(targetHref({ targetType: "license", targetId: "bad id" })).toBeNull();
  });

  it("exports every stored field, masked", () => {
    expect(AUDIT_CSV_COLUMNS.map((c) => c.value(row))).toEqual([
      "6 Oct 2026, 7:52 pm",
      "Vikram Rao",
      "Administrator",
      "Changed plan price",
      "Medical Store Billing \u00B7 Annual license",
      "Plan",
      "plan_1",
      "Festive pricing",
      "Rs 4,499 \u2192 Rs 4,999",
      "103.21.66.\u2022\u2022\u2022",
      "evt1",
    ]);
    expect(auditExportDetail({ q: "", filters: { role: "admin", from: "2026-09-01" } })).toBe("role: Administrator \u00B7 dates: 2026-09-01 to \u2026");
  });

  it("reads page params and download names", () => {
    expect(toUrlSearchParams({ q: "x", "filter[role]": ["owner", "admin"], none: undefined }).toString()).toBe("q=x&filter%5Brole%5D=owner&filter%5Brole%5D=admin");
    expect(drawerIdParam({ id: "cm123" })).toBe("cm123");
    expect(drawerIdParam({ id: "../etc" })).toBeNull();
    expect(dispositionFileName(`attachment; filename="audit-log-2026-10-07.csv"; filename*=UTF-8''audit-log-2026-10-07.csv`, "x.csv")).toBe("audit-log-2026-10-07.csv");
    expect(dispositionFileName(null, "fallback.csv")).toBe("fallback.csv");
  });
});
