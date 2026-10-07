/**
 * Admin Coupons (decisions.md Phase 6): create paused with IST day bounds, rule checks, audited edits (old -> new),
 * pause/activate, the destructive delete (reason + typed code, refused once any order used the code) and the list.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { couponCreateSchema } from "@/lib/admin/coupons/schemas";
import {
  createCoupon,
  deleteCoupon,
  getCouponDetail,
  listCoupons,
  setCouponActive,
  updateCoupon,
} from "@/lib/admin/coupons/service";
import { db } from "@/lib/db";
import { auditRows, makeOrderWithCoupon, makeProduct, rejection, staffFixture, TAG, type StaffFixture } from "./admin-coupons-fixtures";

let finance: StaffFixture;
let support: StaffFixture;
let product: { id: string; name: string };

beforeAll(async () => {
  [finance, support, product] = await Promise.all([staffFixture("FINANCE"), staffFixture("SUPPORT"), makeProduct()]);
});

const input = (overrides: Record<string, unknown> = {}) =>
  couponCreateSchema.parse({
    code: `m5-${TAG()}`,
    type: "PERCENT",
    value: 10,
    label: "10% off for the test",
    startsOn: "2026-10-01",
    endsOn: "2026-10-31",
    maxRedemptions: 50,
    ...overrides,
  });

describe("createCoupon", () => {
  it("creates an upper-case, paused coupon with IST day bounds and one audit row", async () => {
    const data = input({ productIds: [product.id], planTypes: ["ANNUAL"], minSubtotal: 200_000 });
    const dto = await createCoupon(data, { actor: finance.actor }, db, new Date("2026-10-07T06:00:00Z"));
    expect(dto.code).toBe(data.code.toUpperCase());
    expect(dto.active).toBe(false);
    expect(dto.status).toBe("paused");
    expect(dto.startsAt).toBe("2026-09-30T18:30:00.000Z");
    expect(dto.endsAt).toBe("2026-10-31T18:29:59.999Z");
    expect(dto.scope).toBe(`${product.name} \u00b7 Annual plans \u00b7 min \u20b92,000`);
    const rows = await auditRows("coupon", dto.code);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "Created coupon", actorId: finance.user.id, actorRole: "finance" });
  });

  it("refuses a code that exists (422 code), out-of-range values, reversed dates and unknown products", async () => {
    const data = input();
    await createCoupon(data, { actor: finance.actor });
    const dup = await rejection(createCoupon({ ...data }, { actor: finance.actor }));
    expect(dup).toMatchObject({ status: 422, code: "validation_failed" });
    expect((dup.details?.fieldErrors as Record<string, string[]>).code?.[0]).toMatch(/already exists/);

    const bad = await rejection(
      createCoupon(input({ value: 150, endsOn: "2026-09-01", productIds: ["no-such-product"] }), { actor: finance.actor }),
    );
    expect(Object.keys(bad.details?.fieldErrors as object).sort()).toEqual(["endsOn", "productIds", "value"]);
    const flat = await rejection(createCoupon(input({ type: "FLAT", value: 50 }), { actor: finance.actor }));
    expect((flat.details?.fieldErrors as Record<string, string[]>).value?.[0]).toMatch(/₹1/);
  });

  it("rejects bodies that are not strict (unknown keys) or codes with spaces", () => {
    expect(couponCreateSchema.safeParse({ ...input(), active: true }).success).toBe(false);
    expect(couponCreateSchema.safeParse({ ...input(), code: "TWO WORDS" }).success).toBe(false);
  });
});

describe("updateCoupon", () => {
  it("audits old -> new for changed rules and writes nothing when nothing changed", async () => {
    const c = await createCoupon(input(), { actor: finance.actor });
    const res = await updateCoupon(c.code, { value: 15, maxRedemptions: 80, endsOn: "2026-11-15" }, { actor: finance.actor });
    expect(res.changed).toBe(true);
    expect(res.coupon).toMatchObject({ value: 15, maxRedemptions: 80, endsOn: "2026-11-15" });
    const rows = await auditRows("coupon", c.code);
    expect(rows.map((r) => r.action)).toEqual(["Created coupon", "Updated coupon"]);
    expect(rows[1]?.detail).toBe("10% \u2192 15% \u00b7 ends 31 Oct 2026 \u2192 15 Nov 2026 \u00b7 limit 50 \u2192 80");

    const same = await updateCoupon(c.code, { value: 15 }, { actor: finance.actor });
    expect(same.changed).toBe(false);
    expect(await auditRows("coupon", c.code)).toHaveLength(2);
    expect(await rejection(updateCoupon(c.code, {}, { actor: finance.actor }))).toMatchObject({ status: 422 });
  });

  it("keeps the limit at or above the redemptions so far, and 404s unknown codes", async () => {
    const c = await createCoupon(input(), { actor: finance.actor });
    await db.coupon.update({ where: { code: c.code }, data: { redemptions: 12 } });
    const err = await rejection(updateCoupon(c.code, { maxRedemptions: 5 }, { actor: finance.actor }));
    expect((err.details?.fieldErrors as Record<string, string[]>).maxRedemptions?.[0]).toMatch(/used 12 times/);
    expect(await rejection(updateCoupon("NOPE-404-X", { value: 5 }, { actor: finance.actor }))).toMatchObject({ status: 404 });
  });

  it("switches between percent and amount off", async () => {
    const c = await createCoupon(input(), { actor: finance.actor });
    const res = await updateCoupon(c.code, { type: "FLAT", value: 50_000 }, { actor: finance.actor });
    expect(res.coupon.discountLabel).toBe("\u20b9500 off");
    expect((await auditRows("coupon", c.code)).at(-1)?.detail).toBe("10% \u2192 \u20b9500");
  });
});

describe("pause / activate", () => {
  it("toggles `active`, audits each change once and ignores repeats", async () => {
    const c = await createCoupon(input({ startsOn: "2026-01-01", endsOn: "2030-12-31" }), { actor: finance.actor });
    const on = await setCouponActive(c.code, true, { actor: finance.actor });
    expect(on).toMatchObject({ changed: true, coupon: { active: true, status: "active" } });
    expect((await setCouponActive(c.code, true, { actor: finance.actor })).changed).toBe(false);
    const off = await setCouponActive(c.code, false, { actor: finance.actor });
    expect(off.coupon.status).toBe("paused");
    expect((await auditRows("coupon", c.code)).map((r) => r.action)).toEqual(["Created coupon", "Activated coupon", "Paused coupon"]);
  });
});

describe("deleteCoupon (coupons.delete: reason + typed code)", () => {
  const ctx = () => ({ staff: finance.staff, actor: finance.actor });

  it("needs a reason and the exact code before anything happens", async () => {
    const c = await createCoupon(input(), { actor: finance.actor });
    expect(await rejection(deleteCoupon(c.code, { confirmId: c.code }, ctx()))).toMatchObject({ status: 422, code: "reason_required" });
    expect(await rejection(deleteCoupon(c.code, { reason: "Typo in code", confirmId: "WRONG" }, ctx()))).toMatchObject({
      status: 422,
      code: "confirm_mismatch",
    });
    expect(await db.coupon.findUnique({ where: { code: c.code } })).not.toBeNull();
  });

  it("refuses Support (no coupons.manage)", async () => {
    const c = await createCoupon(input(), { actor: finance.actor });
    const err = await rejection(deleteCoupon(c.code, { reason: "Not needed", confirmId: c.code }, { staff: support.staff, actor: support.actor }));
    expect(err.status).toBe(403);
  });

  it("refuses a code that any order used (409, no audit row) and suggests pausing", async () => {
    const c = await createCoupon(input(), { actor: finance.actor });
    await makeOrderWithCoupon(c.code);
    const err = await rejection(deleteCoupon(c.code, { reason: "Campaign over", confirmId: c.code }, ctx()));
    expect(err).toMatchObject({ status: 409, code: "coupon_used" });
    expect(err.message).toMatch(/Pause it instead/);
    expect((await auditRows("coupon", c.code)).map((r) => r.action)).toEqual(["Created coupon"]);
    expect((await getCouponDetail(c.code)).orderCount).toBe(1);
  });

  it("deletes an unused code with exactly one audit row carrying the reason", async () => {
    const c = await createCoupon(input(), { actor: finance.actor });
    expect(await deleteCoupon(c.code.toLowerCase(), { reason: "  Created by mistake  ", confirmId: c.code }, ctx())).toEqual({ code: c.code });
    expect(await db.coupon.findUnique({ where: { code: c.code } })).toBeNull();
    const rows = (await auditRows("coupon", c.code)).filter((r) => r.action === "Deleted coupon");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "Created by mistake", actorId: finance.user.id });
  });
});

describe("listCoupons", () => {
  it("derives statuses and filters, searches and sorts", async () => {
    const t = TAG();
    const now = new Date("2026-10-07T06:00:00Z");
    const live = await createCoupon(input({ code: `LIVE-${t}`, label: `List ${t} live` }), { actor: finance.actor });
    await setCouponActive(live.code, true, { actor: finance.actor });
    const later = await createCoupon(input({ code: `LATER-${t}`, label: `List ${t} later`, startsOn: "2026-12-01", endsOn: "2026-12-31" }), { actor: finance.actor });
    await setCouponActive(later.code, true, { actor: finance.actor });
    await createCoupon(input({ code: `PAUSED-${t}`, label: `List ${t} paused` }), { actor: finance.actor });
    const used = await createCoupon(input({ code: `USED-${t}`, label: `List ${t} used`, maxRedemptions: 3 }), { actor: finance.actor });
    await db.coupon.update({ where: { code: used.code }, data: { redemptions: 3, active: true } });

    const base = { q: t, filters: {}, sort: { id: "code" as const, desc: false }, page: 1, pageSize: 25 };
    const all = await listCoupons(base, db, now);
    expect(all.items.map((c) => [c.code, c.status])).toEqual([
      [`LATER-${t}`, "scheduled"],
      [`LIVE-${t}`, "active"],
      [`PAUSED-${t}`, "paused"],
      [`USED-${t}`, "expired"],
    ]);
    const scheduled = await listCoupons({ ...base, filters: { status: "scheduled" } }, db, now);
    expect(scheduled.items.map((c) => c.code)).toEqual([`LATER-${t}`]);
    const paged = await listCoupons({ ...base, pageSize: 2, page: 2 }, db, now);
    expect(paged).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(paged.items.map((c) => c.code)).toEqual([`PAUSED-${t}`, `USED-${t}`]);
  });
});
