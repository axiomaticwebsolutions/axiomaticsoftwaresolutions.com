/**
 * Staff & roles API (app/api/admin/staff/**): Owner only; the list contract (q, filter[role|status], sort, paging ->
 * { items, total, page, pageSize }), detail, role change with a reason (exactly one audit row; not your own role),
 * deactivation that ends the person's sessions at once, the CSV export (audited) and 403 for other roles.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as exportGET } from "@/app/api/admin/staff/export.csv/route";
import { POST as deactivatePOST } from "@/app/api/admin/staff/[id]/deactivate/route";
import { GET as memberGET, PATCH as memberPATCH } from "@/app/api/admin/staff/[id]/route";
import { GET as listGET, POST as invitePOST } from "@/app/api/admin/staff/route";
import { GET as auditGET } from "@/app/api/admin/audit/route";
import type { StaffRow } from "@/lib/admin/staff/model";
import { db } from "@/lib/db";
import { callRoute, errorCodeOf, makeStaff, startSession, type TestSession } from "../support/admin-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

type Page = { items: StaffRow[]; total: number; page: number; pageSize: number };
const marker = `m7r${randomBytes(3).toString("hex")}`;
let owner: TestSession;
let admin: TestSession;

beforeAll(async () => {
  owner = await startSession(await makeStaff("OWNER", { name: `Owner ${marker}` }));
  admin = await startSession(await makeStaff("ADMIN", { name: `Admin ${marker}` }));
  await makeStaff("SUPPORT", { name: `Support ${marker} Zed` });
  await makeStaff("SUPPORT", { name: `Support ${marker} Amy`, status: "DEACTIVATED" });
});

const list = (query: string, session: TestSession = owner) => callRoute(jar, listGET, { path: `/api/admin/staff?${query}`, session });

describe("GET /api/admin/staff", () => {
  it("searches, filters, sorts and pages", async () => {
    const res = await list(`q=${marker}&filter[role]=support&sort=name`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(page.items.map((r) => [r.name, r.status])).toEqual([
      [`Support ${marker} Amy`, "deactivated"],
      [`Support ${marker} Zed`, "active"],
    ]);
    const active = (await (await list(`q=${marker}&filter[status]=deactivated`)).json()) as Page;
    expect(active.items.map((r) => r.name)).toEqual([`Support ${marker} Amy`]);
    const paged = (await (await list(`q=${marker}&sort=-name&pageSize=1&page=2`)).json()) as Page;
    expect(paged).toMatchObject({ total: 4, page: 2, pageSize: 1 });
    expect(paged.items.map((r) => r.name)).toEqual([`Support ${marker} Amy`]);
    // Lenient: unknown filters and sorts fall back to defaults.
    expect((await list(`q=${marker}&filter[role]=boss&sort=password`)).status).toBe(200);
    const row = page.items[0] as StaffRow & Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["createdAt", "email", "id", "invite", "lastActiveAt", "name", "role", "status", "twoStepEnabled"]);
  });

  it("is Owner only", async () => {
    const res = await list("", admin);
    expect([res.status, await errorCodeOf(res)]).toEqual([403, "forbidden"]);
    const post = await callRoute(jar, invitePOST, { method: "POST", path: "/api/admin/staff", body: { email: `x.${marker}@axiomatic.test`, role: "SUPPORT" }, session: admin });
    expect(post.status).toBe(403);
    expect(await db.user.count({ where: { email: `x.${marker}@axiomatic.test` } })).toBe(0);
  });
});

describe("PATCH /api/admin/staff/:id", () => {
  it("needs a reason, changes the role with one audit row and never your own role", async () => {
    const target = await makeStaff("SUPPORT");
    const path = `/api/admin/staff/${target.id}`;
    const patch = (body: unknown, session = owner, id = target.id) =>
      callRoute(jar, memberPATCH, { method: "PATCH", path, params: { id }, body, session });
    const noReason = await patch({ role: "ADMIN" });
    expect([noReason.status, await errorCodeOf(noReason)]).toEqual([422, "reason_required"]);
    const extra = await patch({ role: "ADMIN", reason: "Promotion", note: "x" });
    expect([extra.status, await errorCodeOf(extra)]).toEqual([422, "validation_failed"]);
    const ok = await patch({ role: "ADMIN", reason: "Promotion" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { staff: StaffRow }).staff.role).toBe("ADMIN");
    expect(await db.auditLog.count({ where: { targetId: target.id, action: "Changed staff role" } })).toBe(1);
    const own = await patch({ role: "ADMIN", reason: "Self demotion" }, owner, owner.user.id);
    expect([own.status, await errorCodeOf(own)]).toEqual([409, "own_role"]);
    const detail = await callRoute(jar, memberGET, { path, params: { id: target.id }, session: owner });
    expect(((await detail.json()) as { staff: StaffRow }).staff).toMatchObject({ id: target.id, role: "ADMIN" });
  });
});

describe("POST /api/admin/staff/:id/deactivate", () => {
  it("ends the person's sessions at once", async () => {
    const target = await startSession(await makeStaff("ADMIN"));
    expect((await callRoute(jar, auditGET, { path: "/api/admin/audit", session: target })).status).toBe(200);
    const res = await callRoute(jar, deactivatePOST, {
      method: "POST",
      path: `/api/admin/staff/${target.user.id}/deactivate`,
      params: { id: target.user.id },
      body: { reason: "Contract ended" },
      session: owner,
    });
    expect(res.status).toBe(200);
    const after = await callRoute(jar, auditGET, { path: "/api/admin/audit", session: target });
    expect([after.status, await errorCodeOf(after)]).toEqual([401, "unauthorized"]);
  });
});

describe("GET /api/admin/staff/export.csv", () => {
  it("exports the filtered staff as CSV and audits the export", async () => {
    const res = await callRoute(jar, exportGET, { path: `/api/admin/staff/export.csv?q=${marker}&filter[role]=support`, session: owner });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("x-row-count")).toBe("2");
    const text = await res.text();
    const lines = text.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe('"Name","Email","Role","Status","Two-step sign-in","Last active (IST)","Added (IST)"');
    // Default order: role, then active before deactivated, then name.
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual([`"Support ${marker} Zed"`, `"Support ${marker} Amy"`]);
    expect(text).not.toMatch(/argon2|passwordHash/);
    const audit = await db.auditLog.findFirstOrThrow({ where: { actorId: owner.user.id, action: "Exported report", target: "Staff" }, orderBy: { createdAt: "desc" } });
    expect(audit.detail).toBe(`CSV \u00B7 2 rows \u00B7 role: Support \u00B7 search: ${marker}`);
  });
});
