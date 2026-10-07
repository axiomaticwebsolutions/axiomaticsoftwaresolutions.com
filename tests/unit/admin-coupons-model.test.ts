import { describe, expect, it } from "vitest";
import { couponBody, couponDraft, couponPatch, addDaysToDate } from "@/components/admin/coupons/coupon-draft";
import { exportHref, exportToast } from "@/components/admin/coupons/export-model";
import { formErrorsFrom } from "@/components/admin/coupons/form-errors";
import {
  COUPONS_LIST,
  couponRedemptionsText,
  couponScope,
  couponStatus,
  couponUsageLabel,
  couponUsagePct,
  filterAndSortCoupons,
  istDateOf,
  type CouponDto,
} from "@/lib/admin/coupons/model";
import { couponRuleErrors, couponUpdateSchema, isCalendarDate } from "@/lib/admin/coupons/schemas";
import { ApiClientError } from "@/lib/client/api";
import { defaultListState } from "@/lib/url-state";

const now = new Date("2026-10-07T06:00:00Z");
const base = { active: true, startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2026-10-31T00:00:00Z"), redemptions: 0, maxRedemptions: 10 };

describe("couponStatus", () => {
  it("derives expired > paused > scheduled > active", () => {
    expect(couponStatus(base, now)).toBe("active");
    expect(couponStatus({ ...base, active: false }, now)).toBe("paused");
    expect(couponStatus({ ...base, startsAt: new Date("2026-11-01T00:00:00Z") }, now)).toBe("scheduled");
    expect(couponStatus({ ...base, endsAt: new Date("2026-10-06T00:00:00Z"), active: false }, now)).toBe("expired");
    expect(couponStatus({ ...base, redemptions: 10 }, now)).toBe("expired");
    expect(couponStatus({ ...base, maxRedemptions: null, redemptions: 999 }, now)).toBe("active");
  });
});

describe("coupon text", () => {
  it("builds the prototype scope, usage and redemption copy", () => {
    expect(couponScope({ productIds: [], planTypes: [], minSubtotal: 200_000 })).toBe("All products \u00b7 min \u20b92,000");
    expect(couponScope({ productIds: [], planTypes: ["ANNUAL", "SUBSCRIPTION"], minSubtotal: null })).toBe("Annual & subscription plans");
    expect(couponScope({ productIds: ["a", "b", "c"], planTypes: [], minSubtotal: null }, { a: "A" })).toBe("3 products");
    expect(couponScope({ productIds: ["cheque"], planTypes: ["ANNUAL"], minSubtotal: null }, { cheque: "Cheque Printing" })).toBe(
      "Cheque Printing \u00b7 Annual plans",
    );
    expect(couponUsageLabel({ redemptions: 14, maxRedemptions: 200 })).toBe("14 / 200");
    expect(couponUsageLabel({ redemptions: 1200, maxRedemptions: null })).toBe("1,200 used");
    expect(couponRedemptionsText({ redemptions: 200, maxRedemptions: 200 })).toBe("200 of 200 \u00b7 limit reached");
    expect(couponUsagePct({ redemptions: 1, maxRedemptions: 3 })).toBe(33.3);
    expect(istDateOf(new Date("2026-10-06T19:00:00Z"))).toBe("2026-10-07");
  });
});

describe("coupon rules and drafts", () => {
  it("checks ranges, dates, limits and products", () => {
    const rules = { type: "PERCENT" as const, value: 0, startsOn: "2026-10-02", endsOn: "2026-10-01", maxRedemptions: 2, productIds: ["x"], planTypes: [] };
    expect(Object.keys(couponRuleErrors(rules, { redemptions: 3, knownProductIds: new Set() })).sort()).toEqual([
      "endsOn",
      "maxRedemptions",
      "productIds",
      "value",
    ]);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(couponUpdateSchema.safeParse({ code: "NEW" }).success).toBe(false);
  });

  it("converts rupees to paise and sends only changed fields", () => {
    const draft = { ...couponDraft(null, "2026-10-07"), code: "test-1", type: "FLAT" as const, value: "499.50", minSubtotal: "2,000", maxRedemptions: "" };
    const { body, errors } = couponBody(draft);
    expect(errors).toEqual({});
    expect(body).toMatchObject({ code: "TEST-1", value: 49_950, minSubtotal: 200_000, maxRedemptions: null, endsOn: "2026-11-06" });
    expect(couponBody({ ...draft, value: "abc", maxRedemptions: "1.5" }).errors).toHaveProperty("value");
    const stored = { type: "FLAT", value: 49_950, label: "", minSubtotal: 200_000, productIds: [], planTypes: [], startsOn: "2026-10-07", endsOn: "2026-11-06", maxRedemptions: null } as unknown as CouponDto;
    expect(couponPatch(stored, body)).toEqual({});
    expect(couponPatch(stored, { ...body, maxRedemptions: 5, productIds: ["p"] })).toEqual({ maxRedemptions: 5, productIds: ["p"] });
    expect(addDaysToDate("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("filterAndSortCoupons and exports", () => {
  const dto = (code: string, status: CouponDto["status"], redemptions: number, startsAt: string): CouponDto =>
    ({ code, status, redemptions, maxRedemptions: 100, startsAt, label: `${code} label`, scope: "All products" }) as CouponDto;
  const rows = [dto("B", "paused", 50, "2026-01-02"), dto("A", "active", 10, "2026-01-03"), dto("C", "expired", 90, "2026-01-01")];

  it("filters by status and search and sorts by usage ratio", () => {
    const q = { q: "", filters: {}, sort: { id: "usage" as const, desc: true } };
    expect(filterAndSortCoupons(rows, q).map((c) => c.code)).toEqual(["C", "B", "A"]);
    expect(filterAndSortCoupons(rows, { ...q, filters: { status: "paused" } }).map((c) => c.code)).toEqual(["B"]);
    expect(filterAndSortCoupons(rows, { ...q, q: "a label" }).map((c) => c.code)).toEqual(["A"]);
    expect(filterAndSortCoupons(rows, { ...q, sort: { id: "starts", desc: true } }).map((c) => c.code)).toEqual(["A", "B", "C"]);
  });

  it("builds export URLs without paging and the export toast", () => {
    const state = { ...defaultListState(COUPONS_LIST), q: "diwali", filters: { status: "active" }, page: 3 };
    expect(exportHref("/api/admin/coupons/export.csv", state, COUPONS_LIST)).toBe("/api/admin/coupons/export.csv?q=diwali&filter%5Bstatus%5D=active");
    expect(exportToast(1, "coupons.csv", false)).toBe("Exported 1 row \u00b7 coupons.csv");
  });

  it("reads field and form errors from API errors", () => {
    const err = new ApiClientError(422, "validation_failed", "Please fix", { fieldErrors: { code: ["Taken"] }, formErrors: [] });
    expect(formErrorsFrom(err)).toEqual({ fields: { code: "Taken" }, form: null });
    expect(formErrorsFrom(new ApiClientError(409, "coupon_used", "Pause it instead."))).toEqual({ fields: {}, form: "Pause it instead." });
  });
});
