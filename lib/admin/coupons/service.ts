/**
 * Admin Coupons service (decisions.md Phase 6; api-contracts section 7: coupons POST, PATCH, /pause, /activate,
 * DELETE). Server-only. Every write runs in one transaction with its audit row and locks the coupon row first
 * (SELECT ... FOR UPDATE), so it queues behind checkouts that hold the same lock (lib/checkout/coupon-hold.ts).
 *
 * - New coupons start paused; codes are upper-case and unique, and never change (orders keep the code they used).
 * - Dates are IST calendar days: startsOn -> 00:00 IST, endsOn -> 23:59:59.999 IST (the bounds checkout compares).
 * - Delete is destructive (reason + typed code, one audit row) and refused once any order used the code: paid
 *   orders keep their discount and unpaid ones may still be paid, so the answer is "Pause it instead".
 */
import "server-only";
import type { Coupon, PlanType, StaffRole } from "@/generated/prisma/client";
import { runDestructive, type DestructiveInput } from "@/lib/admin/destructive";
import { pageResult, type ListPage } from "@/lib/admin/list-query";
import { audit, type AuditActor } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/auth/flows/common";
import { endOfDayIST, formatDateIST, startOfDayIST } from "@/lib/dates";
import { db, type Db, type Tx } from "@/lib/db";
import { errors } from "@/lib/http";
import { formatINR } from "@/lib/money";
import {
  COUPON_COPY,
  COUPON_PLAN_TYPES,
  couponDiscountLabel,
  couponDiscountValue,
  couponScope,
  couponStatus,
  filterAndSortCoupons,
  istDateOf,
  normalizeCouponCode,
  type CouponDto,
  type CouponListQuery,
  type CouponPlanType,
} from "./model";
import { COUPON_ERRORS, couponRuleErrors, type CouponCreateInput, type CouponRules, type CouponUpdateInput } from "./schemas";

export type CouponActorContext = { actor: AuditActor };
export type CouponStaffContext = { staff: { id: string; role: StaffRole }; actor: AuditActor };

export type CouponProductOption = { id: string; name: string };

/** Safety cap: coupons are made by staff one at a time, so the whole table is loaded and filtered in memory. */
export const COUPON_LOAD_LIMIT = 2000;

/** Products a coupon can be limited to (every product, any status: hidden products may still renew). */
export async function couponProductOptions(client: Db = db): Promise<CouponProductOption[]> {
  const rows = await client.product.findMany({ select: { id: true, shortName: true }, orderBy: [{ rank: "asc" }, { id: "asc" }] });
  return rows.map((r) => ({ id: r.id, name: r.shortName }));
}

function namesOf(products: readonly CouponProductOption[]): Record<string, string> {
  return Object.fromEntries(products.map((p) => [p.id, p.name]));
}

/** The admin DTO of a coupon row. */
export function toCouponDto(c: Coupon, productNames: Readonly<Record<string, string>>, now: Date): CouponDto {
  return {
    code: c.code,
    type: c.type,
    value: c.value,
    label: c.label,
    minSubtotal: c.minSubtotal,
    productIds: [...c.productIds],
    planTypes: [...c.planTypes],
    startsAt: c.startsAt.toISOString(),
    endsAt: c.endsAt.toISOString(),
    startsOn: istDateOf(c.startsAt),
    endsOn: istDateOf(c.endsAt),
    maxRedemptions: c.maxRedemptions,
    redemptions: c.redemptions,
    active: c.active,
    status: couponStatus(c, now),
    discountLabel: couponDiscountLabel(c.type, c.value),
    scope: couponScope(c, productNames),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Every coupon (newest start first) and the product options of the editor. */
export async function loadCoupons(
  client: Db = db,
  now: Date = new Date(),
): Promise<{ coupons: CouponDto[]; products: CouponProductOption[] }> {
  const [rows, products] = await Promise.all([
    client.coupon.findMany({ orderBy: [{ startsAt: "desc" }, { code: "asc" }], take: COUPON_LOAD_LIMIT }),
    couponProductOptions(client),
  ]);
  const names = namesOf(products);
  return { coupons: rows.map((c) => toCouponDto(c, names, now)), products };
}

/** GET /api/admin/coupons: search, status filter, sort and paging over the derived rows. */
export async function listCoupons(query: CouponListQuery, client: Db = db, now: Date = new Date()): Promise<ListPage<CouponDto>> {
  const { coupons } = await loadCoupons(client, now);
  const rows = filterAndSortCoupons(coupons, query);
  const start = (query.page - 1) * query.pageSize;
  return pageResult(rows.slice(start, start + query.pageSize), rows.length, query);
}

export type CouponOrderRow = { id: string; createdAt: string; status: string; discountPaise: number; discountLabel: string };
export type CouponDetail = { coupon: CouponDto; orders: CouponOrderRow[]; orderCount: number };

/** One coupon with the newest orders that used it (no customer data: ids, dates, status and discount). */
export async function getCouponDetail(rawCode: string, client: Db = db, now: Date = new Date()): Promise<CouponDetail> {
  const code = normalizeCouponCode(rawCode);
  const [coupon, products, orders, orderCount] = await Promise.all([
    client.coupon.findUnique({ where: { code } }),
    couponProductOptions(client),
    client.order.findMany({
      where: { couponCode: code },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 5,
      select: { id: true, createdAt: true, status: true, discountPaise: true },
    }),
    client.order.count({ where: { couponCode: code } }),
  ]);
  if (!coupon) throw errors.notFound("Coupon");
  return {
    coupon: toCouponDto(coupon, namesOf(products), now),
    orders: orders.map((o) => ({
      id: o.id,
      createdAt: o.createdAt.toISOString(),
      status: o.status,
      discountPaise: o.discountPaise,
      discountLabel: o.discountPaise > 0 ? `\u2212${formatINR(o.discountPaise)}` : formatINR(0),
    })),
    orderCount,
  };
}

// ---------- Writes ----------

async function lockCouponRow(tx: Tx, code: string): Promise<Coupon> {
  await tx.$queryRaw`SELECT "code" FROM "Coupon" WHERE "code" = ${code} FOR UPDATE`;
  const coupon = await tx.coupon.findUnique({ where: { code } });
  if (!coupon) throw errors.notFound("Coupon");
  return coupon;
}

async function knownProductIds(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx.product.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

const codeTaken = () => errors.validation({ code: COUPON_ERRORS.codeTaken });

/** POST /api/admin/coupons: creates a paused coupon (audited "Created coupon"). */
export async function createCoupon(input: CouponCreateInput, ctx: CouponActorContext, client: typeof db = db, now: Date = new Date()): Promise<CouponDto> {
  const productIds = unique(input.productIds);
  const planTypes = unique(input.planTypes);
  try {
    return await client.$transaction(async (tx) => {
      const known = await knownProductIds(tx, productIds);
      const rules: CouponRules = { ...input, productIds, planTypes };
      const fieldErrors = couponRuleErrors(rules, { redemptions: 0, knownProductIds: known });
      if (Object.keys(fieldErrors).length > 0) throw errors.validation(fieldErrors);
      if (await tx.coupon.findUnique({ where: { code: input.code }, select: { code: true } })) throw codeTaken();
      const created = await tx.coupon.create({
        data: {
          code: input.code,
          type: input.type,
          value: input.value,
          label: input.label,
          minSubtotal: input.minSubtotal,
          productIds,
          planTypes,
          startsAt: startOfDayIST(input.startsOn),
          endsAt: endOfDayIST(input.endsOn),
          maxRedemptions: input.maxRedemptions,
          active: false,
        },
      });
      const names = namesOf(await couponProductOptions(tx));
      const dto = toCouponDto(created, names, now);
      await audit(tx, ctx.actor, {
        action: "Created coupon",
        target: created.code,
        targetType: "coupon",
        targetId: created.code,
        detail: `${dto.discountLabel} \u00b7 ${dto.scope} \u00b7 paused`,
      });
      return dto;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw codeTaken();
    throw error;
  }
}

function limitText(n: number | null): string {
  return n === null ? "no limit" : n.toLocaleString("en-IN");
}

function minText(paise: number | null): string {
  return paise === null ? "none" : formatINR(paise);
}

/** Old -> new phrases for the audit detail ("10% \u2192 15% \u00b7 limit 200 \u2192 300"). */
export function couponChanges(
  before: Pick<Coupon, "type" | "value" | "label" | "minSubtotal" | "productIds" | "planTypes" | "startsAt" | "endsAt" | "maxRedemptions">,
  after: typeof before,
  productNames: Readonly<Record<string, string>>,
): string[] {
  const arrow = " \u2192 ";
  const out: string[] = [];
  if (before.type !== after.type || before.value !== after.value) {
    out.push(`${couponDiscountValue(before.type, before.value)}${arrow}${couponDiscountValue(after.type, after.value)}`);
  }
  if (before.label !== after.label) out.push("checkout label");
  const scopeBefore = couponScope({ ...before, minSubtotal: null }, productNames);
  const scopeAfter = couponScope({ ...after, minSubtotal: null }, productNames);
  if (scopeBefore !== scopeAfter) out.push(`applies to ${scopeBefore}${arrow}${scopeAfter}`);
  if (before.minSubtotal !== after.minSubtotal) out.push(`min ${minText(before.minSubtotal)}${arrow}${minText(after.minSubtotal)}`);
  if (before.startsAt.getTime() !== after.startsAt.getTime()) {
    out.push(`starts ${formatDateIST(before.startsAt)}${arrow}${formatDateIST(after.startsAt)}`);
  }
  if (before.endsAt.getTime() !== after.endsAt.getTime()) out.push(`ends ${formatDateIST(before.endsAt)}${arrow}${formatDateIST(after.endsAt)}`);
  if (before.maxRedemptions !== after.maxRedemptions) {
    out.push(`limit ${limitText(before.maxRedemptions)}${arrow}${limitText(after.maxRedemptions)}`);
  }
  return out;
}

export type CouponWriteResult = { coupon: CouponDto; changed: boolean };

/** PATCH /api/admin/coupons/:code: merges the patch, checks the rules again and audits "Updated coupon" (old -> new). */
export async function updateCoupon(
  rawCode: string,
  patch: CouponUpdateInput,
  ctx: CouponActorContext,
  client: typeof db = db,
  now: Date = new Date(),
): Promise<CouponWriteResult> {
  if (Object.values(patch).every((v) => v === undefined)) throw errors.validation({}, [COUPON_ERRORS.nothingToSave]);
  const code = normalizeCouponCode(rawCode);
  return client.$transaction(async (tx) => {
    const current = await lockCouponRow(tx, code);
    const productIds = patch.productIds ? unique(patch.productIds) : current.productIds;
    const planTypes = patch.planTypes ? unique(patch.planTypes) : current.planTypes;
    const rules: CouponRules = {
      type: patch.type ?? current.type,
      value: patch.value ?? current.value,
      startsOn: patch.startsOn ?? istDateOf(current.startsAt),
      endsOn: patch.endsOn ?? istDateOf(current.endsAt),
      maxRedemptions: patch.maxRedemptions === undefined ? current.maxRedemptions : patch.maxRedemptions,
      productIds,
      planTypes: planTypes.filter((t): t is CouponPlanType => (COUPON_PLAN_TYPES as readonly PlanType[]).includes(t)),
    };
    // Products already on the coupon stay valid even if they were removed from the catalog since.
    const known = await knownProductIds(tx, productIds);
    for (const id of current.productIds) known.add(id);
    const fieldErrors = couponRuleErrors(rules, { redemptions: current.redemptions, knownProductIds: known });
    if (Object.keys(fieldErrors).length > 0) throw errors.validation(fieldErrors);

    const next = {
      type: rules.type,
      value: rules.value,
      label: patch.label ?? current.label,
      minSubtotal: patch.minSubtotal === undefined ? current.minSubtotal : patch.minSubtotal,
      productIds,
      planTypes,
      startsAt: patch.startsOn ? startOfDayIST(patch.startsOn) : current.startsAt,
      endsAt: patch.endsOn ? endOfDayIST(patch.endsOn) : current.endsAt,
      maxRedemptions: rules.maxRedemptions,
    };
    const names = namesOf(await couponProductOptions(tx));
    const changes = couponChanges(current, next, names);
    if (changes.length === 0) return { coupon: toCouponDto(current, names, now), changed: false };
    const updated = await tx.coupon.update({ where: { code }, data: next });
    await audit(tx, ctx.actor, {
      action: "Updated coupon",
      target: code,
      targetType: "coupon",
      targetId: code,
      detail: changes.join(" \u00b7 "),
    });
    return { coupon: toCouponDto(updated, names, now), changed: true };
  });
}

/**
 * POST /api/admin/coupons/:code/pause and /activate (no confirmation, as prototyped): audited "Paused coupon" /
 * "Activated coupon". Repeating the current state changes nothing and writes no audit row.
 */
export async function setCouponActive(
  rawCode: string,
  active: boolean,
  ctx: CouponActorContext,
  client: typeof db = db,
  now: Date = new Date(),
): Promise<CouponWriteResult> {
  const code = normalizeCouponCode(rawCode);
  return client.$transaction(async (tx) => {
    const current = await lockCouponRow(tx, code);
    const names = namesOf(await couponProductOptions(tx));
    if (current.active === active) return { coupon: toCouponDto(current, names, now), changed: false };
    const updated = await tx.coupon.update({ where: { code }, data: { active } });
    const dto = toCouponDto(updated, names, now);
    await audit(tx, ctx.actor, {
      action: active ? "Activated coupon" : "Paused coupon",
      target: code,
      targetType: "coupon",
      targetId: code,
      detail: active && dto.status !== "active" ? `Status: ${dto.status}` : null,
    });
    return { coupon: dto, changed: true };
  });
}

/** Orders that used `code`, paid or not (each one keeps the code, so the coupon must stay). */
export async function couponUseCount(tx: Db, coupon: Pick<Coupon, "code" | "redemptions">): Promise<number> {
  // One after the other: `tx` can be an interactive transaction, whose single connection runs one query at a time.
  const orders = await tx.order.count({ where: { couponCode: coupon.code } });
  const redemptions = await tx.couponRedemption.count({ where: { couponCode: coupon.code } });
  return Math.max(orders, redemptions, coupon.redemptions);
}

/**
 * DELETE /api/admin/coupons/:code (DESTRUCTIVE_ACTIONS "coupons.delete"): reason + the typed code, then one transaction
 * with the delete and its audit row. 409 `coupon_used` when any order used the code ("Pause it instead").
 */
export async function deleteCoupon(
  rawCode: string,
  input: DestructiveInput,
  ctx: CouponStaffContext,
  client: typeof db = db,
): Promise<{ code: string }> {
  const code = normalizeCouponCode(rawCode);
  return runDestructive(
    "coupons.delete",
    {
      staff: ctx.staff,
      actor: ctx.actor,
      input,
      targetId: code,
      target: code,
      targetType: "coupon",
      client,
      detail: (r: { detail: string }) => r.detail,
    },
    async (tx) => {
      const coupon = await lockCouponRow(tx, code);
      const used = await couponUseCount(tx, coupon);
      if (used > 0) throw errors.conflict("coupon_used", COUPON_COPY.usedCannotDelete(code, used), { orders: used });
      await tx.coupon.delete({ where: { code } });
      return { code, detail: `${couponDiscountLabel(coupon.type, coupon.value)} \u00b7 never used` };
    },
  ).then(({ code: deleted }) => ({ code: deleted }));
}

// ---------- CSV ----------

const COUPON_STATUS_TEXT: Readonly<Record<CouponDto["status"], string>> = {
  active: "Active",
  scheduled: "Scheduled",
  paused: "Paused",
  expired: "Expired",
};

/** coupons.csv columns (status labels, IST dates, rupee amounts as on screen). */
export const COUPON_CSV_COLUMNS = [
  { header: "Code", value: (c: CouponDto) => c.code },
  { header: "Discount", value: (c: CouponDto) => c.discountLabel },
  { header: "Checkout label", value: (c: CouponDto) => c.label },
  { header: "Applies to", value: (c: CouponDto) => c.scope },
  { header: "Status", value: (c: CouponDto) => COUPON_STATUS_TEXT[c.status] },
  { header: "Used", value: (c: CouponDto) => c.redemptions },
  { header: "Limit", value: (c: CouponDto) => c.maxRedemptions ?? "" },
  { header: "Starts", value: (c: CouponDto) => c.startsOn },
  { header: "Ends", value: (c: CouponDto) => c.endsOn },
] as const;
