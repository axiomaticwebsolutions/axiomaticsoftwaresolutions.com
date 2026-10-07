/**
 * GET /api/admin/reports and GET /api/admin/reports/export.csv through adminRoute (decisions.md Phase 6): reports need
 * `reports.view` (Owner, Administrator, Finance), exports `reports.export` (Owner, Finance); every export writes one
 * "Exported report" audit row naming the report and its scope; an unknown report is a 422 that audits nothing.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as EXPORT } from "@/app/api/admin/reports/export.csv/route";
import { GET as REPORTS } from "@/app/api/admin/reports/route";
import type { ReportsData } from "@/lib/admin/reports/model";
import { CSV_BOM } from "@/lib/csv";
import { db } from "@/lib/db";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers } from "../support/admin-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

let callers: AdminCallers;
beforeAll(async () => {
  callers = await makeAdminCallers();
});

const exportsBy = (actorId: string) =>
  db.auditLog.findMany({ where: { actorId, action: "Exported report" }, orderBy: { createdAt: "asc" } });
const exportPath = (query: string) => `/api/admin/reports/export.csv${query}`;

describe("GET /api/admin/reports", () => {
  it("needs reports.view", async () => {
    expect((await callRoute(jar, REPORTS, { path: "/api/admin/reports", session: null })).status).toBe(401);
    expect((await callRoute(jar, REPORTS, { path: "/api/admin/reports", session: callers.customer })).status).toBe(403);
    expect((await callRoute(jar, REPORTS, { path: "/api/admin/reports", session: callers.SUPPORT })).status).toBe(403);
    for (const role of ["OWNER", "ADMIN", "FINANCE"] as const) {
      const res = await callRoute(jar, REPORTS, { path: "/api/admin/reports?range=90d", session: callers[role] });
      expect(res.status, role).toBe(200);
      expect(res.headers.get("cache-control"), role).toBe("no-store");
      const body = (await res.json()) as ReportsData;
      expect(body.range, role).toBe("90d");
      expect(body.salesByMonth.rows.length, role).toBeGreaterThanOrEqual(3);
      expect(body.scope.startsWith("Last 90 days ("), role).toBe(true);
    }
  });
});

describe("GET /api/admin/reports/export.csv", () => {
  it("needs reports.export: Administrator and Support are refused without an audit row", async () => {
    for (const role of ["ADMIN", "SUPPORT"] as const) {
      const res = await callRoute(jar, EXPORT, { path: exportPath("?report=license-health"), session: callers[role] });
      expect(res.status, role).toBe(403);
      expect(await exportsBy(callers[role].user.id), role).toEqual([]);
    }
    expect((await callRoute(jar, EXPORT, { path: exportPath("?report=license-health"), session: null })).status).toBe(401);
  });

  it("answers 422 for an unknown or missing report and audits nothing", async () => {
    for (const query of ["", "?report=passwords", "?report=sales-register%00"]) {
      const res = await callRoute(jar, EXPORT, { path: exportPath(query), session: callers.FINANCE });
      expect(res.status, query).toBe(422);
      expect(await errorCodeOf(res), query).toBe("validation_failed");
    }
    expect(await exportsBy(callers.FINANCE.user.id)).toEqual([]);
  });

  it("downloads the CSV and writes one audit row with the report and its scope", async () => {
    const res = await callRoute(jar, EXPORT, { path: exportPath("?report=sales-by-month&range=7d"), session: callers.FINANCE });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="sales-by-month-7d-[0-9]{4}-[0-9]{2}-[0-9]{2}[.]csv"/);
    // Response.text() drops a leading byte order mark, so read the bytes.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text.slice(1).split("\r\n")[0]).toBe(
      '"Month","Invoices","Taxable","GST","Invoice value","Credit notes","Credit note taxable","Net taxable"',
    );
    const rows = Number(res.headers.get("x-row-count"));
    expect(rows).toBeGreaterThanOrEqual(2);
    const audits = await exportsBy(callers.FINANCE.user.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorRole: "finance", target: "Sales by month", targetType: "report" });
    expect(audits[0]?.detail?.startsWith(`CSV \u00B7 ${rows} rows \u00B7 Last 7 days (`)).toBe(true);
  });

  it("lets the Owner export the license register with masked keys", async () => {
    const res = await callRoute(jar, EXPORT, { path: exportPath("?report=license-register"), session: callers.OWNER });
    expect(res.status).toBe(200);
    const header = (await res.text()).split("\r\n")[0];
    expect(header).toContain('"Key"');
    const [audit] = await exportsBy(callers.OWNER.user.id);
    expect(audit).toMatchObject({ target: "License register" });
    expect(audit?.detail).toContain("All licenses on ");
  });
});
