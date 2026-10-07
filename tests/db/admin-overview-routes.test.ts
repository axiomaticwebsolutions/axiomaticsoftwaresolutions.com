/**
 * GET /api/admin/overview through adminRoute (decisions.md Phase 6): any active staff member may read it, signed-out
 * callers get 401 and customers 403, the recent activity is only included for roles with `audit.view`, the range
 * parameter is lenient, and responses are never cached.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/overview/route";
import type { OverviewData } from "@/lib/admin/overview/model";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers, type TestSession } from "../support/admin-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

let callers: AdminCallers;
beforeAll(async () => {
  callers = await makeAdminCallers();
});

const get = (session: TestSession | null, query = "") => callRoute(jar, GET, { path: `/api/admin/overview${query}`, session });

describe("GET /api/admin/overview", () => {
  it("answers 401 signed out and 403 for customers", async () => {
    const out = await get(null);
    expect(out.status).toBe(401);
    expect(out.headers.get("cache-control")).toBe("no-store");
    const customer = await get(callers.customer);
    expect(customer.status).toBe(403);
    expect(await errorCodeOf(customer)).toBe("forbidden");
  });

  it("includes recent activity for Owner and Administrator only", async () => {
    for (const role of ["OWNER", "ADMIN", "SUPPORT", "FINANCE"] as const) {
      const res = await get(callers[role], "?range=7d");
      expect(res.status, role).toBe(200);
      expect(res.headers.get("cache-control"), role).toBe("no-store");
      const body = (await res.json()) as OverviewData;
      expect(body.range, role).toBe("7d");
      expect(body.revenue.bars, role).toHaveLength(7);
      expect(body.kpis.revenue, role).toEqual(expect.objectContaining({ paise: expect.any(Number) }));
      if (role === "OWNER" || role === "ADMIN") expect(Array.isArray(body.recentActivity), role).toBe(true);
      else expect(body.recentActivity, role).toBeNull();
    }
  });

  it("falls back to 30 days for an unknown range", async () => {
    const body = (await (await get(callers.SUPPORT, "?range=5y")).json()) as OverviewData;
    expect(body.range).toBe("30d");
    expect(body.revenue.bars).toHaveLength(30);
  });

  it("refuses cross-site requests", async () => {
    const res = await callRoute(jar, GET, { path: "/api/admin/overview", session: callers.OWNER, headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
  });
});
