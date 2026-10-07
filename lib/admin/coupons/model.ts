/**
 * Admin Coupons (Admin Console.dc.html #coupons; decisions.md Phase 6): the derived status, the discount and scope
 * text, the list URL contract shared by the page, the client table and GET /api/admin/coupons, and the DTO the API
 * returns. Pure and client-safe.
 *
 * Dates are IST calendar days: a coupon starts at 00:00 IST of its start day and ends at 23:59:59.999 IST of its end
 * day (lib/dates endOfDayIST), the bounds lib/pricing checks at checkout.
 */
import type { CouponType, PlanType } from "@/generated/prisma/enums";
import type { ListQuerySpec } from "@/lib/admin/list-query";
import { istParts } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { defineListState } from "@/lib/url-state";

/** Derived from `active`, the dates and the redemption limit (the schema stores no status). */
export const COUPON_STATUSES = ["active", "scheduled", "paused", "expired"] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

export const COUPON_STATUS_LABELS: Readonly<Record<CouponStatus, string>> = {
  active: "Active",
  scheduled: "Scheduled",
  paused: "Paused",
  expired: "Expired",
};

/** Plan types a coupon can be limited to (trials are free, so they are never discounted). */
export const COUPON_PLAN_TYPES = ["ONE_TIME", "ANNUAL", "SUBSCRIPTION", "DEVICE_ADDON", "MAINTENANCE"] as const satisfies readonly PlanType[];
export type CouponPlanType = (typeof COUPON_PLAN_TYPES)[number];

export const COUPON_PLAN_TYPE_LABELS: Readonly<Record<CouponPlanType, string>> = {
  ONE_TIME: "One-time",
  ANNUAL: "Annual",
  SUBSCRIPTION: "Subscription",
  DEVICE_ADDON: "Device add-on",
  MAINTENANCE: "Maintenance",
};

/** Upper-case letters, digits and hyphens, 3 to 40 characters (checkout accepts up to 40). */
export const COUPON_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
export const COUPON_PERCENT_MAX = 100;
/** Largest flat discount: Rs 1,00,000. */
export const COUPON_FLAT_MAX_PAISE = 10_000_000;
/** Largest minimum order value: Rs 10,00,000. */
export const COUPON_MIN_SUBTOTAL_MAX_PAISE = 100_000_000;
export const COUPON_MAX_REDEMPTIONS_MAX = 1_000_000;
export const COUPON_LABEL_MAX = 120;

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

export type CouponStatusInput = {
  active: boolean;
  startsAt: Date;
  endsAt: Date;
  redemptions: number;
  maxRedemptions: number | null;
};

/** True once every allowed redemption has been used. */
export function couponUsedUp(c: Pick<CouponStatusInput, "redemptions" | "maxRedemptions">): boolean {
  return c.maxRedemptions !== null && c.redemptions >= c.maxRedemptions;
}

/**
 * expired (ended or used up) wins over paused, which wins over scheduled; otherwise active. Matches the checkout
 * rules in lib/pricing (a code is refused after `endsAt`, before `startsAt`, while paused and when used up).
 */
export function couponStatus(c: CouponStatusInput, now: Date): CouponStatus {
  const t = now.getTime();
  if (t > c.endsAt.getTime() || couponUsedUp(c)) return "expired";
  if (!c.active) return "paused";
  if (t < c.startsAt.getTime()) return "scheduled";
  return "active";
}

/** Order of the STATUS column when sorted ascending. */
export const COUPON_STATUS_RANK: Readonly<Record<CouponStatus, number>> = { active: 0, scheduled: 1, paused: 2, expired: 3 };

/** "10% off" / "₹500 off". */
export function couponDiscountLabel(type: CouponType, value: number): string {
  return type === "PERCENT" ? `${value}% off` : `${formatINR(value)} off`;
}

/** "10%" / "₹500" (drawer). */
export function couponDiscountValue(type: CouponType, value: number): string {
  return type === "PERCENT" ? `${value}%` : formatINR(value);
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

/**
 * Prototype "APPLIES TO": "All products · min ₹2,000", "Annual & subscription plans", "Cheque Printing",
 * "Cheque Printing · Annual plans", "3 products". Unknown product ids read as the id.
 */
export function couponScope(
  c: { productIds: readonly string[]; planTypes: readonly PlanType[]; minSubtotal: number | null },
  productNames: Readonly<Record<string, string>> = {},
): string {
  const parts: string[] = [];
  if (c.productIds.length > 0) {
    const names = c.productIds.map((id) => productNames[id] ?? id);
    parts.push(names.length <= 2 ? joinAnd(names) : `${names.length} products`);
  }
  if (c.planTypes.length > 0) {
    const labels = c.planTypes.map((t, i) => {
      const label = COUPON_PLAN_TYPE_LABELS[t as CouponPlanType] ?? t;
      return i === 0 ? label : label.toLowerCase();
    });
    parts.push(`${joinAnd(labels)} plans`);
  }
  if (parts.length === 0) parts.push("All products");
  if (c.minSubtotal !== null && c.minSubtotal > 0) parts.push(`min ${formatINR(c.minSubtotal)}`);
  return parts.join(" \u00b7 ");
}

const count = (n: number) => n.toLocaleString("en-IN");

/** "14 / 200" (table), or "14 used" without a limit. */
export function couponUsageLabel(c: Pick<CouponStatusInput, "redemptions" | "maxRedemptions">): string {
  return c.maxRedemptions === null ? `${count(c.redemptions)} used` : `${count(c.redemptions)} / ${count(c.maxRedemptions)}`;
}

/** "14 of 200" (drawer), "200 of 200 · limit reached", "14 · no limit". */
export function couponRedemptionsText(c: Pick<CouponStatusInput, "redemptions" | "maxRedemptions">): string {
  if (c.maxRedemptions === null) return `${count(c.redemptions)} \u00b7 no limit`;
  const base = `${count(c.redemptions)} of ${count(c.maxRedemptions)}`;
  return couponUsedUp(c) ? `${base} \u00b7 limit reached` : base;
}

/** Share of the limit used, 0-100 (0 without a limit). */
export function couponUsagePct(c: Pick<CouponStatusInput, "redemptions" | "maxRedemptions">): number {
  if (c.maxRedemptions === null || c.maxRedemptions <= 0) return 0;
  return Math.min(100, Math.round((c.redemptions / c.maxRedemptions) * 1000) / 10);
}

/** "2026-10-07": the IST calendar date of an instant (date inputs and the API's startsOn/endsOn). */
export function istDateOf(d: Date): string {
  const p = istParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** A coupon as the admin API returns it (money in paise, instants in ISO, calendar days in IST). */
export type CouponDto = {
  code: string;
  type: CouponType;
  /** Percent, or paise for FLAT. */
  value: number;
  label: string;
  minSubtotal: number | null;
  productIds: string[];
  planTypes: PlanType[];
  startsAt: string;
  endsAt: string;
  startsOn: string;
  endsOn: string;
  maxRedemptions: number | null;
  redemptions: number;
  active: boolean;
  status: CouponStatus;
  discountLabel: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
};

// ---------- List URL contract (?q=&filter[status]=&sort=&page=) ----------

export const COUPON_SORTS = ["code", "status", "usage", "starts"] as const;
export type CouponSort = (typeof COUPON_SORTS)[number];
export const COUPON_PAGE_SIZE = 25;

/** Client table state (useListState). */
export const COUPONS_LIST = defineListState<"status">({
  filterStyle: "bracket",
  filters: { status: { values: COUPON_STATUSES } },
  sortable: COUPON_SORTS,
  defaultSort: { id: "starts", desc: true },
  pageSize: COUPON_PAGE_SIZE,
});

/** Server parsing of the same URL (GET /api/admin/coupons, its CSV export and the page). */
export const COUPON_LIST_SPEC = {
  filters: { status: COUPON_STATUSES },
  sortable: COUPON_SORTS,
  defaultSort: { id: "starts", desc: true },
  defaultPageSize: COUPON_PAGE_SIZE,
} satisfies ListQuerySpec<{ status: typeof COUPON_STATUSES }, CouponSort>;

export type CouponListQuery = {
  q: string;
  filters: { status?: CouponStatus };
  sort: { id: CouponSort; desc: boolean };
  page: number;
  pageSize: number;
};

function usageRatio(c: CouponDto): number {
  return c.maxRedemptions === null || c.maxRedemptions <= 0 ? 0 : c.redemptions / c.maxRedemptions;
}

const COMPARE: Readonly<Record<CouponSort, (a: CouponDto, b: CouponDto) => number>> = {
  code: (a, b) => a.code.localeCompare(b.code),
  status: (a, b) => COUPON_STATUS_RANK[a.status] - COUPON_STATUS_RANK[b.status],
  usage: (a, b) => usageRatio(a) - usageRatio(b) || a.redemptions - b.redemptions,
  starts: (a, b) => a.startsAt.localeCompare(b.startsAt),
};

/** Search (code, checkout label, scope), status filter and sort over the coupons (a small, admin-made table). */
export function filterAndSortCoupons(
  rows: readonly CouponDto[],
  query: Pick<CouponListQuery, "q" | "filters" | "sort">,
): CouponDto[] {
  const q = query.q.trim().toLowerCase();
  const status = query.filters.status;
  const dir = query.sort.desc ? -1 : 1;
  const compare = COMPARE[query.sort.id];
  return rows
    .filter((c) => (!status || c.status === status) && (!q || `${c.code} ${c.label} ${c.scope}`.toLowerCase().includes(q)))
    .sort((a, b) => dir * (compare(a, b) || a.code.localeCompare(b.code)));
}

/** Prototype copy plus the new states (owner review). */
export const COUPON_COPY = {
  searchPlaceholder: "Search code or description",
  searchLabel: "Search coupons",
  caption: "Coupons",
  newCoupon: "New coupon",
  created: "Coupon created (paused). Activate it when it\u2019s ready.",
  saved: "Changes saved",
  noChanges: "No changes to save",
  paused: "Coupon paused",
  activated: "Coupon active",
  deleted: "Coupon deleted",
  deleteConsequence: "Customers can no longer use it. Past orders keep their discount.",
  stacking: "One code per order",
  applied: "Before GST",
  usedCannotDelete: (code: string, n: number) =>
    `${code} has been used on ${n.toLocaleString("en-IN")} ${n === 1 ? "order" : "orders"}, so it can\u2019t be deleted. Pause it instead.`,
} as const;
