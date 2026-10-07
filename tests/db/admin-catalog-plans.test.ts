/**
 * Admin Plans API (decisions.md Phase 6): create with the plan rules, edits (price audited old -> new, Support cannot
 * change prices), archive / restore (reason, one audit row), bulk archive (one row per plan, one transaction), the
 * list grouped by product, filters and the CSV export.
 */
import type * as NextCache from "next/cache";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as plansRoute from "@/app/api/admin/plans/route";
import * as planRoute from "@/app/api/admin/plans/[id]/route";
import * as archiveRoute from "@/app/api/admin/plans/[id]/archive/route";
import * as restoreRoute from "@/app/api/admin/plans/[id]/restore/route";
import * as bulkRoute from "@/app/api/admin/plans/bulk-archive/route";
import * as exportRoute from "@/app/api/admin/plans/export.csv/route";
import { db } from "@/lib/db";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers } from "../support/admin-fixtures";
import { auditRows, makePlan, makeProduct, tag } from "./admin-catalog-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));
vi.mock("next/cache", async (importOriginal) => ({ ...(await importOriginal<typeof NextCache>()), revalidateTag }));

let callers: AdminCallers;
beforeAll(async () => {
  callers = await makeAdminCallers();
});
beforeEach(() => revalidateTag.mockClear());

type Json = Record<string, unknown>;
const body = async (res: Response) => (await res.json()) as Json;
const fieldErrors = async (res: Response) => ((await body(res)).error as Json).fieldErrors as Record<string, string[]>;

describe("create", () => {
  it("creates a plan that satisfies its type's rules", async () => {
    const product = await makeProduct();
    const id = `p-annual-${tag()}`;
    const ok = await callRoute(jar, plansRoute.POST, {
      method: "POST",
      path: "/api/admin/plans",
      body: { id, productId: product.id, type: "ANNUAL", name: "Annual license", pricePaise: 499_900, interval: "YEAR", deviceLimit: 1 },
      session: callers.ADMIN,
    });
    expect(ok.status).toBe(201);
    expect((await body(ok)).plan).toMatchObject({ id, archived: false, productName: product.shortName });
    expect((await auditRows(id)).map((r) => [r.action, r.detail])).toEqual([["Created plan", "Annual \u00B7 \u20B94,999"]]);

    const trial = await callRoute(jar, plansRoute.POST, {
      method: "POST",
      path: "/api/admin/plans",
      body: { id: `p-trial-${tag()}`, productId: product.id, type: "TRIAL", name: "Free trial", pricePaise: 100, deviceLimit: 1 },
      session: callers.ADMIN,
    });
    expect(trial.status).toBe(422);
    expect(Object.keys(await fieldErrors(trial)).sort()).toEqual(["pricePaise", "trialDays"]);

    const unknownProduct = await callRoute(jar, plansRoute.POST, {
      method: "POST",
      path: "/api/admin/plans",
      body: { id: `p-x-${tag()}`, productId: `nope-${tag()}`, type: "ONE_TIME", name: "One-time", pricePaise: 100, deviceLimit: 1, updatesMonths: 12 },
      session: callers.OWNER,
    });
    expect(unknownProduct.status).toBe(422);
    expect(await fieldErrors(unknownProduct)).toHaveProperty("productId");

    const finance = await callRoute(jar, plansRoute.POST, {
      method: "POST",
      path: "/api/admin/plans",
      body: { id: `p-y-${tag()}`, productId: product.id, type: "ANNUAL", name: "Annual", pricePaise: 100, interval: "YEAR", deviceLimit: 1 },
      session: callers.FINANCE,
    });
    expect(finance.status).toBe(403);
  });
});

describe("edit", () => {
  it("audits a price change old -> new; Support cannot change prices", async () => {
    const product = await makeProduct();
    const plan = await makePlan(product.id, { pricePaise: 600_000, deviceLimit: 1 });
    const path = `/api/admin/plans/${plan.id}`;
    const support = await callRoute(jar, planRoute.PATCH, { method: "PATCH", path, params: { id: plan.id }, body: { pricePaise: 1 }, session: callers.SUPPORT });
    expect(support.status).toBe(403);

    const res = await callRoute(jar, planRoute.PATCH, {
      method: "PATCH",
      path,
      params: { id: plan.id },
      body: { pricePaise: 650_050, deviceLimit: 2, summary: "For one counter" },
      session: callers.ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ changed: true, plan: { pricePaise: 650_050, deviceLimit: 2, summary: "For one counter" } });
    expect(revalidateTag).toHaveBeenCalledWith("catalog");
    const rows = await auditRows(plan.id);
    expect(rows.map((r) => [r.action, r.detail])).toEqual([
      ["Changed plan price", "\u20B96,000 \u2192 \u20B96,500.50 \u00B7 Device limit 1 \u2192 2 \u00B7 Summary"],
    ]);

    const same = await callRoute(jar, planRoute.PATCH, { method: "PATCH", path, params: { id: plan.id }, body: { pricePaise: 650_050 }, session: callers.ADMIN });
    expect(await body(same)).toMatchObject({ changed: false });
    expect(await auditRows(plan.id)).toHaveLength(1);

    const broken = await callRoute(jar, planRoute.PATCH, { method: "PATCH", path, params: { id: plan.id }, body: { deviceLimit: null }, session: callers.ADMIN });
    expect(broken.status).toBe(422);
    expect(await fieldErrors(broken)).toHaveProperty("deviceLimit");

    const named = await callRoute(jar, planRoute.PATCH, { method: "PATCH", path, params: { id: plan.id }, body: { name: "Annual (1 PC)" }, session: callers.OWNER });
    expect(named.status).toBe(200);
    expect((await auditRows(plan.id)).at(-1)).toMatchObject({ action: "Updated plan", detail: "Name" });
  });
});

describe("archive and restore", () => {
  it("needs a reason and writes exactly one audit row per change", async () => {
    const product = await makeProduct();
    const plan = await makePlan(product.id);
    const path = `/api/admin/plans/${plan.id}/archive`;
    const noReason = await callRoute(jar, archiveRoute.POST, { method: "POST", path, params: { id: plan.id }, body: { reason: " ab " }, session: callers.OWNER });
    expect(noReason.status).toBe(422);
    expect(await errorCodeOf(noReason)).toBe("reason_required");
    expect((await db.plan.findUniqueOrThrow({ where: { id: plan.id } })).archived).toBe(false);

    const archived = await callRoute(jar, archiveRoute.POST, {
      method: "POST",
      path,
      params: { id: plan.id },
      body: { reason: "Replaced by the new annual plan" },
      session: callers.OWNER,
    });
    expect(archived.status).toBe(200);
    expect(((await body(archived)).plan as Json).archived).toBe(true);
    const again = await callRoute(jar, archiveRoute.POST, { method: "POST", path, params: { id: plan.id }, body: { reason: "Again please" }, session: callers.OWNER });
    expect(await errorCodeOf(again)).toBe("already_archived");

    const restored = await callRoute(jar, restoreRoute.POST, {
      method: "POST",
      path: `/api/admin/plans/${plan.id}/restore`,
      params: { id: plan.id },
      body: { reason: "Back on sale" },
      session: callers.ADMIN,
    });
    expect(restored.status).toBe(200);
    expect((await auditRows(plan.id)).map((r) => [r.action, r.reason])).toEqual([
      ["Archived plan", "Replaced by the new annual plan"],
      ["Restored plan", "Back on sale"],
    ]);
  });

  it("bulk-archives in one transaction with one audit row per archived plan", async () => {
    const product = await makeProduct();
    const a = await makePlan(product.id);
    const b = await makePlan(product.id, { archived: true });
    const missingReason = await callRoute(jar, bulkRoute.POST, {
      method: "POST",
      path: "/api/admin/plans/bulk-archive",
      body: { ids: [a.id, b.id] },
      session: callers.ADMIN,
    });
    expect(missingReason.status).toBe(422);
    const unknown = await callRoute(jar, bulkRoute.POST, {
      method: "POST",
      path: "/api/admin/plans/bulk-archive",
      body: { ids: [a.id, `nope-${tag()}`], reason: "Season over" },
      session: callers.ADMIN,
    });
    expect(unknown.status).toBe(422);
    expect((await db.plan.findUniqueOrThrow({ where: { id: a.id } })).archived).toBe(false);

    const res = await callRoute(jar, bulkRoute.POST, {
      method: "POST",
      path: "/api/admin/plans/bulk-archive",
      body: { ids: [a.id, b.id], reason: "Season over" },
      session: callers.ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ archived: [a.id], skipped: [b.id] });
    expect((await auditRows(a.id)).map((r) => [r.action, r.reason])).toEqual([["Archived plan", "Season over"]]);
    expect(await auditRows(b.id)).toHaveLength(0);
  });
});

describe("list and export", () => {
  it("groups plans by product by default and filters by type and status", async () => {
    const first = await makeProduct();
    await db.product.update({ where: { id: first.id }, data: { rank: 1 } });
    const second = await makeProduct();
    await db.product.update({ where: { id: second.id }, data: { rank: 2 } });
    const s1 = await makePlan(second.id, { sortOrder: 1 });
    const f2 = await makePlan(first.id, { sortOrder: 2 });
    const f1 = await makePlan(first.id, { sortOrder: 1, type: "TRIAL", interval: null, trialDays: 15, pricePaise: 0 });
    const archived = await makePlan(second.id, { sortOrder: 2, archived: true });

    const all = await callRoute(jar, plansRoute.GET, { path: `/api/admin/plans?pageSize=100&q=Catalog`, session: callers.SUPPORT });
    const order = ((await body(all)).items as Json[]).map((p) => p.id as string).filter((id) => [s1.id, f1.id, f2.id, archived.id].includes(id));
    expect(order).toEqual([f1.id, f2.id, s1.id, archived.id]);

    const trials = await callRoute(jar, plansRoute.GET, { path: `/api/admin/plans?filter[product]=${first.id}&filter[type]=trial`, session: callers.SUPPORT });
    expect(((await body(trials)).items as Json[]).map((p) => p.id)).toEqual([f1.id]);
    const off = await callRoute(jar, plansRoute.GET, { path: `/api/admin/plans?filter[product]=${second.id}&filter[status]=archived`, session: callers.FINANCE });
    expect(await body(off)).toMatchObject({ total: 1, items: [{ id: archived.id, archived: true }] });
  });

  it("exports plans for Owner and Finance", async () => {
    const product = await makeProduct();
    await makePlan(product.id, { pricePaise: 499_900 });
    const support = await callRoute(jar, exportRoute.GET, { path: `/api/admin/plans/export.csv?filter[product]=${product.id}`, session: callers.SUPPORT });
    expect(support.status).toBe(403);
    const res = await callRoute(jar, exportRoute.GET, { path: `/api/admin/plans/export.csv?filter[product]=${product.id}`, session: callers.OWNER });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("4999.00");
    expect(csv).toContain("Per year");
  });
});
