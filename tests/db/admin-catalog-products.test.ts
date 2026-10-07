/**
 * Admin Products & categories API (decisions.md Phase 6): create (DRAFT), listing and content edits, code lock once
 * licenses exist, publish / hide (reason, blockers, exactly one audit row), category CRUD, list filters, CSV export
 * (reports.export, audited) and storefront revalidation.
 */
import type * as NextCache from "next/cache";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as categoriesRoute from "@/app/api/admin/categories/route";
import * as categoryRoute from "@/app/api/admin/categories/[id]/route";
import * as productsRoute from "@/app/api/admin/products/route";
import * as productRoute from "@/app/api/admin/products/[id]/route";
import * as publishRoute from "@/app/api/admin/products/[id]/publish/route";
import * as hideRoute from "@/app/api/admin/products/[id]/hide/route";
import * as exportRoute from "@/app/api/admin/products/export.csv/route";
import { db } from "@/lib/db";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers } from "../support/admin-fixtures";
import { auditRows, makeCategory, makePlan, makeProduct, makeRelease, tag, VALID_CONTENT } from "./admin-catalog-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));
vi.mock("next/cache", async (importOriginal) => ({ ...(await importOriginal<typeof NextCache>()), revalidateTag }));

let callers: AdminCallers;

beforeAll(async () => {
  callers = await makeAdminCallers();
});

beforeEach(() => {
  revalidateTag.mockClear();
});

type Json = Record<string, unknown>;
const body = async (res: Response) => (await res.json()) as Json;

function newProductBody(categoryId: string, overrides: Json = {}) {
  const t = tag();
  return {
    id: `new-prod-${t}`,
    code: "ZZZ",
    name: `Clinic Billing ${t}`,
    shortName: `Clinic ${t}`,
    tagline: "Billing for clinics",
    summary: "Appointments, prescriptions and GST bills.",
    categoryId,
    platforms: ["windows"],
    icon: "medication",
    ...overrides,
  };
}

async function freeCode(): Promise<string> {
  const { freshProductCode } = await import("../support/product-codes");
  return freshProductCode();
}

describe("categories", () => {
  it("creates, edits and deletes an empty category; refuses one with products", async () => {
    const id = `clinics-${tag()}`;
    const create = await callRoute(jar, categoriesRoute.POST, {
      method: "POST",
      path: "/api/admin/categories",
      body: { id, name: "Clinics", tone: "blue", icon: "medication" },
      session: callers.ADMIN,
    });
    expect(create.status).toBe(201);
    expect(((await body(create)).category as Json).productCount).toBe(0);
    expect(revalidateTag).toHaveBeenCalledWith("catalog");

    const dup = await callRoute(jar, categoriesRoute.POST, {
      method: "POST",
      path: "/api/admin/categories",
      body: { id, name: "Clinics again", tone: "blue", icon: "medication" },
      session: callers.ADMIN,
    });
    expect(dup.status).toBe(422);

    const denied = await callRoute(jar, categoryRoute.PATCH, {
      method: "PATCH",
      path: `/api/admin/categories/${id}`,
      params: { id },
      body: { name: "Clinics & labs" },
      session: callers.SUPPORT,
    });
    expect(denied.status).toBe(403);

    const edit = await callRoute(jar, categoryRoute.PATCH, {
      method: "PATCH",
      path: `/api/admin/categories/${id}`,
      params: { id },
      body: { name: "Clinics & labs", sortOrder: 9 },
      session: callers.OWNER,
    });
    expect(edit.status).toBe(200);
    expect(await body(edit)).toMatchObject({ changed: true, category: { name: "Clinics & labs", sortOrder: 9 } });

    await makeProduct({ categoryId: id });
    const inUse = await callRoute(jar, categoryRoute.DELETE, { method: "DELETE", path: `/api/admin/categories/${id}`, params: { id }, body: { reason: "Merged into Clinics" }, session: callers.OWNER });
    expect(inUse.status).toBe(409);
    expect(await errorCodeOf(inUse)).toBe("category_in_use");

    const empty = await makeCategory();
    // Destructive: a reason is required (api-contracts section 7), and nothing changes without one.
    const noReason = await callRoute(jar, categoryRoute.DELETE, { method: "DELETE", path: `/api/admin/categories/${empty.id}`, params: { id: empty.id }, body: {}, session: callers.OWNER });
    expect([noReason.status, await errorCodeOf(noReason)]).toEqual([422, "reason_required"]);
    expect(await db.category.findUnique({ where: { id: empty.id } })).not.toBeNull();
    const del = await callRoute(jar, categoryRoute.DELETE, {
      method: "DELETE",
      path: `/api/admin/categories/${empty.id}`,
      params: { id: empty.id },
      body: { reason: "Never used" },
      session: callers.OWNER,
    });
    expect(del.status).toBe(200);
    expect(await db.category.findUnique({ where: { id: empty.id } })).toBeNull();
    expect((await auditRows(id)).map((r) => r.action)).toEqual(["Created category", "Updated category"]);
    expect((await auditRows(empty.id)).map((r) => [r.action, r.reason])).toEqual([["Deleted category", "Never used"]]);
  });

  it("lists categories with product counts for any staff role", async () => {
    const category = await makeCategory();
    await makeProduct({ categoryId: category.id, status: "PUBLISHED" });
    await makeProduct({ categoryId: category.id });
    const res = await callRoute(jar, categoriesRoute.GET, { path: `/api/admin/categories?q=${category.id}`, session: callers.FINANCE });
    expect(res.status).toBe(200);
    const items = (await body(res)).items as Json[];
    expect(items.find((c) => c.id === category.id)).toMatchObject({ productCount: 2, publishedCount: 1 });
  });
});

describe("products", () => {
  it("creates a DRAFT product (Owner/Admin only) and rejects a taken id or code", async () => {
    const category = await makeCategory();
    const code = await freeCode();
    const input = newProductBody(category.id, { code: code.toLowerCase() });
    const denied = await callRoute(jar, productsRoute.POST, { method: "POST", path: "/api/admin/products", body: input, session: callers.FINANCE });
    expect(denied.status).toBe(403);

    const res = await callRoute(jar, productsRoute.POST, { method: "POST", path: "/api/admin/products", body: input, session: callers.ADMIN });
    expect(res.status).toBe(201);
    const product = (await body(res)).product as Json;
    expect(product).toMatchObject({ id: input.id, code, status: "DRAFT", contentValid: false, codeLocked: false });
    expect(product.publishBlockers).toHaveLength(3);
    expect((await auditRows(input.id as string)).map((r) => [r.action, r.actorRole])).toEqual([["Created product", "admin"]]);

    const again = await callRoute(jar, productsRoute.POST, {
      method: "POST",
      path: "/api/admin/products",
      body: { ...input, id: `other-${tag()}` },
      session: callers.ADMIN,
    });
    expect(again.status).toBe(422);
    expect(((await body(again)).error as Json).fieldErrors).toHaveProperty("code");

    const badCategory = await callRoute(jar, productsRoute.POST, {
      method: "POST",
      path: "/api/admin/products",
      body: newProductBody(`missing-${tag()}`, { code: await freeCode() }),
      session: callers.ADMIN,
    });
    expect(badCategory.status).toBe(422);
    expect(((await body(badCategory)).error as Json).fieldErrors).toHaveProperty("categoryId");
  });

  it("edits the listing and content, ignores unchanged values and validates related products", async () => {
    const product = await makeProduct();
    const path = `/api/admin/products/${product.id}`;
    const edit = await callRoute(jar, productRoute.PATCH, {
      method: "PATCH",
      path,
      params: { id: product.id },
      body: { tagline: "Fast GST billing", content: VALID_CONTENT },
      session: callers.OWNER,
    });
    expect(edit.status).toBe(200);
    expect(await body(edit)).toMatchObject({ changed: true, product: { tagline: "Fast GST billing", contentValid: true } });
    expect(revalidateTag).toHaveBeenCalledWith("catalog");

    const same = await callRoute(jar, productRoute.PATCH, {
      method: "PATCH",
      path,
      params: { id: product.id },
      body: { tagline: "Fast GST billing" },
      session: callers.OWNER,
    });
    expect(await body(same)).toMatchObject({ changed: false });
    const sameContent = await callRoute(jar, productRoute.PATCH, {
      method: "PATCH",
      path,
      params: { id: product.id },
      body: { content: VALID_CONTENT },
      session: callers.OWNER,
    });
    expect(await body(sameContent)).toMatchObject({ changed: false });
    const rows = await auditRows(product.id);
    expect(rows.map((r) => [r.action, r.detail])).toEqual([["Updated product listing", "Tagline, Page content"]]);

    const badIcon = await callRoute(jar, productRoute.PATCH, {
      method: "PATCH",
      path,
      params: { id: product.id },
      body: { content: { ...VALID_CONTENT, features: [{ icon: "not_an_icon_name", title: "X", body: "Y" }] } },
      session: callers.OWNER,
    });
    expect(badIcon.status).toBe(422);
    expect(((await body(badIcon)).error as Json).fieldErrors).toHaveProperty(["content.features.0.icon"]);

    const self = await callRoute(jar, productRoute.PATCH, {
      method: "PATCH",
      path,
      params: { id: product.id },
      body: { relatedIds: [product.id] },
      session: callers.OWNER,
    });
    expect(self.status).toBe(422);

    const readOnly = await callRoute(jar, productRoute.GET, { path, params: { id: product.id }, session: callers.SUPPORT });
    expect(readOnly.status).toBe(200);
    const supportEdit = await callRoute(jar, productRoute.PATCH, {
      method: "PATCH",
      path,
      params: { id: product.id },
      body: { tagline: "No" },
      session: callers.SUPPORT,
    });
    expect(supportEdit.status).toBe(403);
  });

  it("locks the license prefix once a license exists", async () => {
    const product = await makeProduct();
    const plan = await makePlan(product.id);
    const newCode = await freeCode();
    const change = await callRoute(jar, productRoute.PATCH, {
      method: "PATCH",
      path: `/api/admin/products/${product.id}`,
      params: { id: product.id },
      body: { code: newCode },
      session: callers.OWNER,
    });
    expect(change.status).toBe(200);
    expect((await auditRows(product.id)).at(-1)?.detail).toBe(`License prefix ${product.code} \u2192 ${newCode}`);

    await db.license.create({
      data: {
        id: `LIC-CAT${tag().toUpperCase()}`,
        productId: product.id,
        planId: plan.id,
        accountId: null,
        keyHash: `hash-${tag()}-${tag()}`,
        keyCiphertext: "v1.x.y.z",
        keyLast4: "AAAA",
        updatesUntil: new Date(Date.now() + 86_400_000),
        deviceLimit: 1,
        resetsYear: 2026,
      },
    });
    const locked = await callRoute(jar, productRoute.PATCH, {
      method: "PATCH",
      path: `/api/admin/products/${product.id}`,
      params: { id: product.id },
      body: { code: await freeCode() },
      session: callers.OWNER,
    });
    expect(locked.status).toBe(409);
    expect(await errorCodeOf(locked)).toBe("code_locked");
    const detail = await callRoute(jar, productRoute.GET, { path: `/api/admin/products/${product.id}`, params: { id: product.id }, session: callers.OWNER });
    expect(((await body(detail)).product as Json).codeLocked).toBe(true);
  });
});

describe("publish and hide", () => {
  it("needs a reason, reports blockers, then publishes and hides with exactly one audit row each", async () => {
    const product = await makeProduct();
    const path = `/api/admin/products/${product.id}/publish`;
    const noReason = await callRoute(jar, publishRoute.POST, { method: "POST", path, params: { id: product.id }, body: {}, session: callers.OWNER });
    expect(noReason.status).toBe(422);
    expect(await errorCodeOf(noReason)).toBe("reason_required");

    const blocked = await callRoute(jar, publishRoute.POST, {
      method: "POST",
      path,
      params: { id: product.id },
      body: { reason: "Launch day" },
      session: callers.OWNER,
    });
    expect(blocked.status).toBe(409);
    const error = (await body(blocked)).error as Json;
    expect(error.code).toBe("not_ready");
    expect(error.blockers).toHaveLength(3);
    expect(await auditRows(product.id)).toHaveLength(0);

    await db.product.update({ where: { id: product.id }, data: { content: VALID_CONTENT } });
    await makePlan(product.id);
    await makeRelease(product.id, { status: "PUBLISHED", withFile: true });

    const published = await callRoute(jar, publishRoute.POST, {
      method: "POST",
      path,
      params: { id: product.id },
      body: { reason: "Launch day" },
      session: callers.ADMIN,
    });
    expect(published.status).toBe(200);
    expect(((await body(published)).product as Json).status).toBe("PUBLISHED");
    expect(revalidateTag).toHaveBeenCalledWith("catalog");
    const afterPublish = await auditRows(product.id);
    expect(afterPublish.map((r) => [r.action, r.reason, r.detail])).toEqual([["Published product", "Launch day", "Draft \u2192 Published"]]);

    const twice = await callRoute(jar, publishRoute.POST, { method: "POST", path, params: { id: product.id }, body: { reason: "Again" }, session: callers.ADMIN });
    expect(twice.status).toBe(409);

    const hidePath = `/api/admin/products/${product.id}/hide`;
    const deniedHide = await callRoute(jar, hideRoute.POST, {
      method: "POST",
      path: hidePath,
      params: { id: product.id },
      body: { reason: "Pause sales" },
      session: callers.FINANCE,
    });
    expect(deniedHide.status).toBe(403);
    const hidden = await callRoute(jar, hideRoute.POST, {
      method: "POST",
      path: hidePath,
      params: { id: product.id },
      body: { reason: "Pause sales" },
      session: callers.OWNER,
    });
    expect(hidden.status).toBe(200);
    expect(((await body(hidden)).product as Json).status).toBe("HIDDEN");
    const again = await callRoute(jar, hideRoute.POST, { method: "POST", path: hidePath, params: { id: product.id }, body: { reason: "Again" }, session: callers.OWNER });
    expect(await errorCodeOf(again)).toBe("not_published");
    expect((await auditRows(product.id)).map((r) => r.action)).toEqual(["Published product", "Hid product"]);
  });
});

describe("list and export", () => {
  it("filters by category and status, searches and sorts by the From price", async () => {
    const category = await makeCategory();
    const cheap = await makeProduct({ categoryId: category.id, status: "PUBLISHED" });
    const dear = await makeProduct({ categoryId: category.id, status: "PUBLISHED" });
    const draft = await makeProduct({ categoryId: category.id });
    await makePlan(cheap.id, { pricePaise: 100_000 });
    await makePlan(dear.id, { pricePaise: 900_000 });
    await makePlan(dear.id, { type: "DEVICE_ADDON", interval: null, deviceLimit: null, pricePaise: 1_000 });
    await makeRelease(dear.id, { version: "2.0.0", status: "PUBLISHED", releasedAt: new Date("2026-05-01") });
    await makeRelease(dear.id, { version: "1.9.9", status: "PUBLISHED", releasedAt: new Date("2026-06-01") });

    const res = await callRoute(jar, productsRoute.GET, {
      path: `/api/admin/products?filter[category]=${category.id}&filter[status]=published&sort=-price`,
      session: callers.SUPPORT,
    });
    expect(res.status).toBe(200);
    const page = await body(res);
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    const items = page.items as Json[];
    expect(items.map((p) => p.id)).toEqual([dear.id, cheap.id]);
    expect(items[0]).toMatchObject({ fromPricePaise: 900_000, planCount: 2, latest: { version: "2.0.0" } });

    const search = await callRoute(jar, productsRoute.GET, { path: `/api/admin/products?q=${draft.code}`, session: callers.SUPPORT });
    expect(((await body(search)).items as Json[]).map((p) => p.id)).toEqual([draft.id]);
  });

  it("exports CSV for Owner and Finance only, and audits the export", async () => {
    const category = await makeCategory();
    await makeProduct({ categoryId: category.id });
    const denied = await callRoute(jar, exportRoute.GET, { path: `/api/admin/products/export.csv?filter[category]=${category.id}`, session: callers.ADMIN });
    expect(denied.status).toBe(403);
    const before = await db.auditLog.count({ where: { action: "Exported report", target: "Products" } });
    const res = await callRoute(jar, exportRoute.GET, { path: `/api/admin/products/export.csv?filter[category]=${category.id}`, session: callers.FINANCE });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("x-row-count")).toBe("1");
    const csv = await res.text();
    expect(csv).toContain("License prefix");
    expect(await db.auditLog.count({ where: { action: "Exported report", target: "Products" } })).toBe(before + 1);
  });
});
