/**
 * Coupon routes end to end through adminRoute(): roles (everyone reads, coupons.manage writes, reports.export for the
 * CSV), CSRF on mutations, the strict body, the destructive delete and the audited export.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as activate from "@/app/api/admin/coupons/[code]/activate/route";
import * as item from "@/app/api/admin/coupons/[code]/route";
import * as exportCsv from "@/app/api/admin/coupons/export.csv/route";
import * as collection from "@/app/api/admin/coupons/route";
import { db } from "@/lib/db";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers } from "../support/admin-fixtures";
import { TAG } from "./admin-coupons-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

let callers: AdminCallers;
beforeAll(async () => {
  callers = await makeAdminCallers();
});

const body = (code: string) => ({ code, type: "PERCENT", value: 12, label: "Route test coupon", startsOn: "2026-10-01", endsOn: "2026-12-31" });

describe("coupon routes", () => {
  it("lets Finance create (201, paused) and Support read but not write", async () => {
    const code = `RT-${TAG()}`;
    const created = await callRoute(jar, collection.POST, { method: "POST", path: "/api/admin/coupons", body: body(code), session: callers.FINANCE });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { coupon: { active: boolean } }).coupon.active).toBe(false);

    const list = await callRoute(jar, collection.GET, { path: `/api/admin/coupons?q=${code}&filter[status]=paused`, session: callers.SUPPORT });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toContain("no-store");
    expect(((await list.json()) as { items: { code: string }[]; total: number })).toMatchObject({ total: 1, items: [{ code }] });

    const patch = await callRoute(jar, item.PATCH, { method: "PATCH", path: `/api/admin/coupons/${code}`, params: { code }, body: { value: 20 }, session: callers.SUPPORT });
    expect(patch.status).toBe(403);
    const detail = await callRoute(jar, item.GET, { path: `/api/admin/coupons/${code}`, params: { code }, session: callers.SUPPORT });
    expect(detail.status).toBe(200);
  });

  it("requires CSRF and strict bodies on writes", async () => {
    const code = `RT-${TAG()}`;
    await callRoute(jar, collection.POST, { method: "POST", path: "/api/admin/coupons", body: body(code), session: callers.ADMIN });
    const noCsrf = await callRoute(jar, activate.POST, { method: "POST", path: `/api/admin/coupons/${code}/activate`, params: { code }, session: callers.ADMIN, csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(await errorCodeOf(noCsrf)).toBe("csrf_failed");
    const extra = await callRoute(jar, item.PATCH, { method: "PATCH", path: `/api/admin/coupons/${code}`, params: { code }, body: { value: 20, active: true }, session: callers.ADMIN });
    expect(extra.status).toBe(422);
    const ok = await callRoute(jar, activate.POST, { method: "POST", path: `/api/admin/coupons/${code}/activate`, params: { code }, session: callers.ADMIN });
    expect(ok.status).toBe(200);
  });

  it("deletes with reason + typed code only (422 without), as one audited action", async () => {
    const code = `RT-${TAG()}`;
    await callRoute(jar, collection.POST, { method: "POST", path: "/api/admin/coupons", body: body(code), session: callers.OWNER });
    const missing = await callRoute(jar, item.DELETE, { method: "DELETE", path: `/api/admin/coupons/${code}`, params: { code }, body: {}, session: callers.OWNER });
    expect(missing.status).toBe(422);
    expect(await errorCodeOf(missing)).toBe("reason_required");
    const done = await callRoute(jar, item.DELETE, {
      method: "DELETE",
      path: `/api/admin/coupons/${code}`,
      params: { code },
      body: { reason: "Duplicate of another code", confirmId: code },
      session: callers.OWNER,
    });
    expect(done.status).toBe(200);
    expect(await db.auditLog.count({ where: { targetType: "coupon", targetId: code, action: "Deleted coupon" } })).toBe(1);
  });

  it("exports CSV for Finance (audited) and refuses Administrator", async () => {
    const denied = await callRoute(jar, exportCsv.GET, { path: "/api/admin/coupons/export.csv", session: callers.ADMIN });
    expect(denied.status).toBe(403);
    const before = await db.auditLog.count({ where: { actorId: callers.FINANCE.user.id, action: "Exported report" } });
    const res = await callRoute(jar, exportCsv.GET, { path: "/api/admin/coupons/export.csv?filter[status]=paused", session: callers.FINANCE });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\r\n")[0]).toContain('"Code","Discount","Checkout label","Applies to","Status"');
    expect(await db.auditLog.count({ where: { actorId: callers.FINANCE.user.id, action: "Exported report" } })).toBe(before + 1);
  });
});
