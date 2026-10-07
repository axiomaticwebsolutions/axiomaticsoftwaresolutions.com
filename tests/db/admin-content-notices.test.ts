/**
 * Site banner and sample notice (SiteSetting content.banner / content.sampleNotice): merged patches validated with the
 * settings schema, audited, storefront `settings` revalidated. The shared rows are restored afterwards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as banner from "@/app/api/admin/content/banner/route";
import { noticePatchSchema } from "@/lib/admin/content/schemas";
import { getContentNotices, updateContentNotice } from "@/lib/admin/content/service";
import { db } from "@/lib/db";
import { callRoute, makeAdminCallers, type AdminCallers } from "../support/admin-fixtures";
import { auditRows, rejection, staffFixture, type StaffFixture } from "./admin-coupons-fixtures";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), revalidateTag }));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

const KEYS = ["content.banner", "content.sampleNotice"];
let saved: { key: string; value: unknown }[] = [];
let owner: StaffFixture;
let callers: AdminCallers;

beforeAll(async () => {
  saved = await db.siteSetting.findMany({ where: { key: { in: KEYS } }, select: { key: true, value: true } });
  await db.siteSetting.deleteMany({ where: { key: { in: KEYS } } });
  owner = await staffFixture("OWNER");
  callers = await makeAdminCallers();
});
afterAll(async () => {
  await db.siteSetting.deleteMany({ where: { key: { in: KEYS } } });
  for (const row of saved) await db.siteSetting.create({ data: { key: row.key, value: row.value as object } });
});
beforeEach(() => revalidateTag.mockClear());

describe("storefront notices", () => {
  it("reads the defaults, saves text, enables and disables, each audited once", async () => {
    expect((await getContentNotices()).banner).toMatchObject({ enabled: false, text: "" });
    const text = await updateContentNotice("banner", { text: "  Diwali offer: 20% off  " }, { actor: owner.actor });
    expect(text).toMatchObject({ changed: true, notice: { enabled: false, text: "Diwali offer: 20% off" } });
    const on = await updateContentNotice("banner", { enabled: true }, { actor: owner.actor });
    expect(on.notice.enabled).toBe(true);
    const same = await updateContentNotice("banner", { enabled: true }, { actor: owner.actor });
    expect(same.changed).toBe(false);
    await updateContentNotice("banner", { enabled: false }, { actor: owner.actor });
    const rows = (await auditRows("settings", "content.banner")).filter((r) => r.actorId === owner.user.id);
    expect(rows.map((r) => [r.action, r.detail])).toEqual([
      ["Edited site banner", "Diwali offer: 20% off"],
      ["Enabled site banner", "Diwali offer: 20% off"],
      ["Disabled site banner", "Diwali offer: 20% off"],
    ]);
    expect(revalidateTag).toHaveBeenCalledTimes(3);
    expect(revalidateTag).toHaveBeenCalledWith("settings");
  });

  it("refuses an enabled banner without text and over-long text", async () => {
    await updateContentNotice("banner", { enabled: false, text: "" }, { actor: owner.actor });
    const err = await rejection(updateContentNotice("banner", { enabled: true }, { actor: owner.actor }));
    expect(err.status).toBe(422);
    expect(Object.keys(err.details?.fieldErrors as object)).toEqual(["text"]);
    expect(noticePatchSchema.safeParse({ text: "x".repeat(201) }).success).toBe(false);
    expect(noticePatchSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
  });

  it("turns the sample notice off (audited \u201cDisabled sample notice\u201d)", async () => {
    const res = await updateContentNotice("sample-notice", { enabled: false }, { actor: owner.actor });
    expect(res.notice.enabled).toBe(false);
    expect((await auditRows("settings", "content.sampleNotice")).at(-1)).toMatchObject({ action: "Disabled sample notice" });
  });

  it("is content.manage only over HTTP (Support and Finance 403, Administrator allowed)", async () => {
    for (const role of ["SUPPORT", "FINANCE"] as const) {
      const res = await callRoute(jar, banner.PATCH, { method: "PATCH", path: "/api/admin/content/banner", body: { text: "Nope" }, session: callers[role] });
      expect(res.status, role).toBe(403);
    }
    const ok = await callRoute(jar, banner.PATCH, { method: "PATCH", path: "/api/admin/content/banner", body: { text: "Hello from admin" }, session: callers.ADMIN });
    expect(ok.status).toBe(200);
    const read = await callRoute(jar, banner.GET, { path: "/api/admin/content/banner", session: callers.ADMIN });
    expect(((await read.json()) as { notice: { text: string } }).notice.text).toBe("Hello from admin");
  });
});
