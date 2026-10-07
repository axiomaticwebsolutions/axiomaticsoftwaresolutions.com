/**
 * Audit log API (app/api/admin/audit/**; audit.view = Owner, Administrator): filters (actor role, person, action slug,
 * target type, IST date range), search, sort and paging; the event detail; the CSV export, which is itself audited;
 * and the append-only rule: the area exposes GET handlers only and nothing in it updates or deletes audit rows.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as exportGET } from "@/app/api/admin/audit/export.csv/route";
import { GET as eventGET } from "@/app/api/admin/audit/[id]/route";
import { GET as listGET } from "@/app/api/admin/audit/route";
import type { AuditRow } from "@/lib/admin/audit/model";
import { auditFacets } from "@/lib/admin/audit/service";
import { ADMIN_ROUTES } from "@/lib/admin/routes";
import { db } from "@/lib/db";
import { callRoute, discoverRouteFiles, errorCodeOf, makeStaff, startSession, type TestSession } from "../support/admin-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

type Page = { items: AuditRow[]; total: number; page: number; pageSize: number };
const marker = `M7A${randomBytes(3).toString("hex").toUpperCase()}`;
let owner: TestSession;
let admin: TestSession;
let support: TestSession;
const ids = { refund: "", price: "", webhook: "", reset: "" };

beforeAll(async () => {
  owner = await startSession(await makeStaff("OWNER", { name: "Anita Desai" }));
  admin = await startSession(await makeStaff("ADMIN", { name: "Vikram Rao" }));
  support = await startSession(await makeStaff("SUPPORT", { name: "Sneha Patil" }));
  const rows = [
    { key: "refund" as const, actorId: owner.user.id, actorRole: "owner", action: "Issued refund", targetType: "order", targetId: `AX-${marker}`, at: "2026-09-02T05:00:00.000Z", reason: "Customer request", detail: "Rs 4,128.82" },
    { key: "price" as const, actorId: admin.user.id, actorRole: "admin", action: "Changed plan price", targetType: "plan", targetId: `plan-${marker}`, at: "2026-09-10T18:45:00.000Z", reason: null, detail: "Rs 4,499 \u2192 Rs 4,999" },
    { key: "webhook" as const, actorId: null, actorRole: "system", action: "Webhook rejected", targetType: "webhook", targetId: `evt-${marker}`, at: "2026-09-20T03:00:00.000Z", reason: null, detail: "invalid signature" },
    { key: "reset" as const, actorId: support.user.id, actorRole: "support", action: "Reset devices", targetType: "license", targetId: `LIC-${marker}`, at: "2026-09-30T19:00:00.000Z", reason: "PC crash", detail: "2 devices cleared" },
  ];
  for (const r of rows) {
    const created = await db.auditLog.create({
      data: {
        actorId: r.actorId,
        actorRole: r.actorRole,
        action: r.action,
        target: `${marker} ${r.key}`,
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        detail: r.detail,
        ipPrefix: r.actorId ? "103.21.44.x" : null,
        createdAt: new Date(r.at),
      },
    });
    ids[r.key] = created.id;
  }
});

const list = async (query: string, session: TestSession = owner): Promise<Page> => {
  const res = await callRoute(jar, listGET, { path: `/api/admin/audit?q=${marker}&${query}`, session });
  expect(res.status, query).toBe(200);
  return (await res.json()) as Page;
};
const keysOf = (page: Page) => page.items.map((r) => r.target.split(" ")[1]);

describe("GET /api/admin/audit", () => {
  it("lists newest first with the actor's name and role", async () => {
    const page = await list("");
    expect(page).toMatchObject({ total: 4, page: 1, pageSize: 25 });
    expect(keysOf(page)).toEqual(["reset", "webhook", "price", "refund"]);
    expect(page.items.find((r) => r.id === ids.webhook)).toMatchObject({ actorName: "System", actorRole: "system", ipPrefix: null });
    expect(page.items.find((r) => r.id === ids.refund)).toMatchObject({ actorName: "Anita Desai", reason: "Customer request", ipPrefix: "103.21.44.x" });
  });

  it("filters by role, person, action, target type and IST dates", async () => {
    expect(keysOf(await list("filter[role]=system"))).toEqual(["webhook"]);
    expect(keysOf(await list(`filter[actor]=${admin.user.id}`))).toEqual(["price"]);
    expect(keysOf(await list("filter[action]=reset-devices"))).toEqual(["reset"]);
    expect(keysOf(await list("filter[targetType]=order"))).toEqual(["refund"]);
    // 10 Sep 18:45 UTC is 11 Sep 00:15 IST; 30 Sep 19:00 UTC is 1 Oct 00:30 IST.
    expect(keysOf(await list("filter[from]=2026-09-11&filter[to]=2026-09-30"))).toEqual(["webhook", "price"]);
    expect(keysOf(await list("filter[to]=2026-09-10"))).toEqual(["refund"]);
    // Invalid values are ignored (lenient), never 422.
    expect((await list("filter[role]=boss&filter[from]=2026-02-30&filter[action]=Not%20A%20Slug")).total).toBe(4);
  });

  it("searches reason and detail, sorts by action and pages", async () => {
    const all = await list("");
    expect(all.total).toBe(4);
    const crash = (await (await callRoute(jar, listGET, { path: "/api/admin/audit?q=PC%20crash", session: owner })).json()) as Page;
    expect(crash.items.map((r) => r.id)).toContain(ids.reset);
    expect(keysOf(await list("sort=action"))).toEqual(["price", "refund", "reset", "webhook"]);
    const second = await list("sort=-createdAt&pageSize=2&page=2");
    expect(second).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(keysOf(second)).toEqual(["price", "refund"]);
  });

  it("is closed to Support and Finance", async () => {
    for (const role of ["SUPPORT", "FINANCE"] as const) {
      const session = role === "SUPPORT" ? support : await startSession(await makeStaff("FINANCE"));
      for (const [handler, path, params] of [
        [listGET, "/api/admin/audit", {}],
        [exportGET, "/api/admin/audit/export.csv", {}],
        [eventGET, `/api/admin/audit/${ids.refund}`, { id: ids.refund }],
      ] as const satisfies readonly (readonly [unknown, string, Record<string, string>])[]) {
        const res = await callRoute(jar, handler, { path, params, session });
        expect([res.status, await errorCodeOf(res)], `${role} ${path}`).toEqual([403, "forbidden"]);
      }
    }
  });
});

describe("GET /api/admin/audit/:id", () => {
  it("returns one event, 404 for unknown ids", async () => {
    const res = await callRoute(jar, eventGET, { path: `/api/admin/audit/${ids.price}`, params: { id: ids.price }, session: admin });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { event: AuditRow }).event).toMatchObject({ id: ids.price, action: "Changed plan price", actorName: "Vikram Rao", targetType: "plan" });
    const missing = await callRoute(jar, eventGET, { path: "/api/admin/audit/nope-0000", params: { id: "nope-0000" }, session: admin });
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/admin/audit/export.csv", () => {
  it("exports the filtered rows and records the export itself", async () => {
    const res = await callRoute(jar, exportGET, { path: `/api/admin/audit/export.csv?q=${marker}&filter[role]=owner`, session: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/audit-log-\d{4}-\d{2}-\d{2}\.csv/);
    expect(res.headers.get("x-row-count")).toBe("1");
    const lines = (await res.text()).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe('"When (IST)","Actor","Role","Action","Target","Target type","Target ID","Reason","Detail","IP (masked)","Event ID"');
    expect(lines[1]).toContain('"Anita Desai","Owner","Issued refund"');
    expect(lines[1]).toContain('"103.21.44.\u2022\u2022\u2022"');
    const recorded = await db.auditLog.findFirstOrThrow({ where: { actorId: admin.user.id, action: "Exported report", target: "Audit log" }, orderBy: { createdAt: "desc" } });
    expect(recorded.detail).toBe(`CSV \u00B7 1 row \u00B7 role: Owner \u00B7 search: ${marker}`);
    expect(recorded.targetType).toBe("report");
  });
});

describe("older webhook rows with machine action names", () => {
  it("show as Webhook processed in the list, event, CSV, Action filter, search and facets", async () => {
    const m = `L9W${randomBytes(3).toString("hex").toUpperCase()}`;
    const row = await db.auditLog.create({
      data: { actorId: null, actorRole: "system", action: "order.paid", target: `AX-${m}`, targetType: "order", targetId: `AX-${m}`, detail: `Invoice ${m}`, createdAt: new Date("2019-03-14T06:00:00.000Z") },
    });
    const page = async (query: string): Promise<Page> => {
      const res = await callRoute(jar, listGET, { path: `/api/admin/audit?${query}`, session: owner });
      expect(res.status, query).toBe(200);
      return (await res.json()) as Page;
    };
    expect((await page(`q=${m}`)).items.map((r) => [r.id, r.action])).toEqual([[row.id, "Webhook processed"]]);
    expect((await page(`q=${m}&filter[action]=webhook-processed`)).items.map((r) => r.id)).toEqual([row.id]);
    expect((await page("q=webhook%20processed&filter[from]=2019-03-14&filter[to]=2019-03-14")).items.map((r) => r.id)).toContain(row.id);
    const event = await callRoute(jar, eventGET, { path: `/api/admin/audit/${row.id}`, params: { id: row.id }, session: owner });
    expect(((await event.json()) as { event: AuditRow }).event.action).toBe("Webhook processed");
    const csv = await callRoute(jar, exportGET, { path: `/api/admin/audit/export.csv?q=${m}`, session: owner });
    expect(await csv.text()).toContain('"System","System","Webhook processed"');
    const facets = await auditFacets(db);
    expect(facets.actions.filter((a) => a.value === "webhook-processed")).toEqual([{ value: "webhook-processed", label: "Webhook processed" }]);
    expect(facets.actions.some((a) => a.label === "order.paid")).toBe(false);
  });
});

describe("append-only", () => {
  it("exposes GET handlers only, in the route files and in the registry", async () => {
    const files = discoverRouteFiles(["api", "admin", "audit"]);
    expect(files.map((f) => f.path).sort()).toEqual(["/api/admin/audit", "/api/admin/audit/[id]", "/api/admin/audit/export.csv"]);
    for (const file of files) {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(file.file).href)) as Record<string, unknown>;
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(mod[method], `${file.path} ${method}`).toBeUndefined();
      expect(typeof mod.GET, file.path).toBe("function");
    }
    const registered = ADMIN_ROUTES.filter((r) => r.path.startsWith("/api/admin/audit"));
    expect(registered.length).toBe(3);
    expect(new Set(registered.map((r) => r.method))).toEqual(new Set(["GET"]));
  });

  it("never updates or deletes audit rows in the audit, staff or settings code", () => {
    const roots = ["lib/admin/audit", "lib/admin/staff", "lib/admin/settings", "app/api/admin/audit", "app/api/admin/staff", "app/api/admin/settings"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && /auditLog\.(update|updateMany|upsert|delete|deleteMany)\b|"AuditLog"[^;]*\b(UPDATE|DELETE)\b|\b(UPDATE|DELETE FROM)\s+"AuditLog"/.test(readFileSync(full, "utf8"))) {
          offenders.push(full);
        }
      }
    };
    for (const root of roots) walk(join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });
});
