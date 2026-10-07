/**
 * Admin Plans & license policies (Admin Console.dc.html #plans; api-contracts section 7; decisions.md Phase 6): the
 * plan list (grouped by product by default), detail, create, edit ("Changes apply to new purchases and future
 * renewals"; a price change is audited old -> new), archive / restore (destructive: reason, one audit row) and bulk
 * archive (one audit row per plan, one transaction). Plans are never deleted: orders and licenses refer to them.
 * Every write revalidates the storefront catalog cache. Server-only; routes authorize first.
 */
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { ADMIN_EXPORT_MAX_ROWS } from "@/lib/admin/export";
import { pageResult, searchWhere, toPrismaOrderBy, type ListPage } from "@/lib/admin/list-query";
import { runDestructive, validateDestructive, DESTRUCTIVE_AUDIT_ACTIONS } from "@/lib/admin/destructive";
import { audit } from "@/lib/audit";
import { db as defaultDb, type Prisma, type Tx } from "@/lib/db";
import { errors } from "@/lib/http";
import type { CatalogListQuery, PlanSort } from "./list-config";
import { planTypeFromFilter } from "./model";
import type { CatalogActor, StatusChangeContext } from "./products";
import { revalidateCatalog } from "./revalidate";
import { changedKeys, planAuditTarget, planChangeAudit, type PlanEditable } from "./rules";
import { planRuleIssues, type PlanCreateInput, type PlanUpdateInput } from "./schemas";
import type { AdminPlanDetail, AdminPlanRow, ProductStatusKey } from "./types";
import { formatINR } from "@/lib/money";
import { PLAN_TYPE_LABELS } from "./model";

export type PlanFilterKey = "product" | "type" | "status";
export type PlanListQuery = CatalogListQuery<PlanFilterKey, PlanSort>;

export const PLAN_MESSAGES = {
  idTaken: "A plan with this id already exists.",
  product: "Choose a product.",
  alreadyArchived: "This plan is already archived.",
  notArchived: "This plan is already on sale.",
  bulkMissing: "Some of these plans no longer exist. Refresh the list and try again.",
} as const;

const planInclude = { product: { select: { name: true, shortName: true, status: true } } } satisfies Prisma.PlanInclude;
type PlanWithProduct = Prisma.PlanGetPayload<{ include: typeof planInclude }>;

function toPlanRow(p: PlanWithProduct): AdminPlanRow {
  return {
    id: p.id,
    productId: p.productId,
    productName: p.product.shortName,
    type: p.type,
    name: p.name,
    summary: p.summary,
    pricePaise: p.pricePaise,
    interval: p.interval,
    trialDays: p.trialDays,
    deviceLimit: p.deviceLimit,
    perUnit: p.perUnit,
    maxQty: p.maxQty,
    multiDevice: p.multiDevice,
    updatesMonths: p.updatesMonths,
    popular: p.popular,
    archived: p.archived,
    sortOrder: p.sortOrder,
  };
}

function toPlanDetail(p: PlanWithProduct): AdminPlanDetail {
  return {
    ...toPlanRow(p),
    productFullName: p.product.name,
    productStatus: p.product.status as ProductStatusKey,
    includes: p.includes,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function planWhere(query: Pick<PlanListQuery, "q" | "filters">): Prisma.PlanWhereInput {
  const type = query.filters.type ? planTypeFromFilter(query.filters.type) : null;
  const status = query.filters.status;
  return {
    ...(query.filters.product ? { productId: query.filters.product } : {}),
    ...(type ? { type } : {}),
    ...(status === "archived" ? { archived: true } : status === "on_sale" ? { archived: false } : {}),
    ...(searchWhere<Prisma.PlanWhereInput>(query.q, ["name", "id", "product.name", "product.shortName"]) ?? {}),
  };
}

function planOrderBy(sort: { id: PlanSort; desc: boolean }): Prisma.PlanOrderByWithRelationInput[] {
  return toPrismaOrderBy<Prisma.PlanOrderByWithRelationInput>(sort, {
    name: "name",
    price: "pricePaise",
    product: (dir) => [{ product: { rank: dir } }, { product: { name: dir } }, { productId: dir }, { sortOrder: "asc" }],
  });
}

export async function listPlans(query: PlanListQuery, client: PrismaClient = defaultDb): Promise<ListPage<AdminPlanRow>> {
  const where = planWhere(query);
  const [rows, total] = await Promise.all([
    client.plan.findMany({
      where,
      include: planInclude,
      orderBy: planOrderBy(query.sort),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    client.plan.count({ where }),
  ]);
  return pageResult(rows.map(toPlanRow), total, query);
}

/** Up to ADMIN_EXPORT_MAX_ROWS + 1 rows for the CSV (the extra row marks truncation). */
export async function planExportRows(query: Pick<PlanListQuery, "q" | "filters" | "sort">, client: PrismaClient = defaultDb): Promise<AdminPlanRow[]> {
  const rows = await client.plan.findMany({
    where: planWhere(query),
    include: planInclude,
    orderBy: planOrderBy(query.sort),
    take: ADMIN_EXPORT_MAX_ROWS + 1,
  });
  return rows.map(toPlanRow);
}

export async function getPlanDetail(id: string, client: PrismaClient | Tx = defaultDb): Promise<AdminPlanDetail | null> {
  const plan = await client.plan.findUnique({ where: { id }, include: planInclude });
  return plan ? toPlanDetail(plan) : null;
}

async function requirePlan(id: string, client: PrismaClient | Tx): Promise<AdminPlanDetail> {
  const plan = await getPlanDetail(id, client);
  if (!plan) throw errors.notFound("Plan");
  return plan;
}

// ---------- Create and edit ----------

function priceLabel(paise: number): string {
  return paise > 0 ? formatINR(paise) : "Free";
}

export async function createPlan(input: PlanCreateInput, ctx: CatalogActor, client: PrismaClient = defaultDb): Promise<AdminPlanDetail> {
  let plan: AdminPlanDetail;
  try {
    plan = await client.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: input.productId }, select: { shortName: true } });
      if (!product) throw errors.validation({ productId: PLAN_MESSAGES.product });
      if (await tx.plan.findUnique({ where: { id: input.id }, select: { id: true } })) {
        throw errors.validation({ id: PLAN_MESSAGES.idTaken });
      }
      await tx.plan.create({ data: { ...input, archived: false } });
      await audit(tx, ctx.actor, {
        action: "Created plan",
        target: planAuditTarget(product.shortName, input.name),
        targetType: "plan",
        targetId: input.id,
        detail: `${PLAN_TYPE_LABELS[input.type]} \u00B7 ${priceLabel(input.pricePaise)}`,
      });
      return requirePlan(input.id, tx);
    });
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "P2002") throw errors.validation({ id: PLAN_MESSAGES.idTaken });
    throw e;
  }
  revalidateCatalog();
  return plan;
}

const EDITABLE_KEYS: readonly (keyof PlanEditable)[] = [
  "name",
  "summary",
  "includes",
  "pricePaise",
  "interval",
  "trialDays",
  "deviceLimit",
  "perUnit",
  "maxQty",
  "multiDevice",
  "updatesMonths",
  "popular",
  "sortOrder",
];

function editableOf(p: AdminPlanDetail): PlanEditable {
  const out = {} as Record<keyof PlanEditable, unknown>;
  for (const key of EDITABLE_KEYS) out[key] = p[key];
  return out as PlanEditable;
}

async function lockPlan(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Plan" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw errors.notFound("Plan");
}

export type PlanUpdateResult = { plan: AdminPlanDetail; changed: boolean };

/**
 * Edits apply to new purchases and future renewals; issued licenses keep their terms. The edited plan must still
 * satisfy the plan rules for its type (422 with the field). One audit row: "Changed plan price" (detail "₹old → ₹new
 * · ...") or "Updated plan". Equal values are ignored (`changed: false`, no audit row).
 */
export async function updatePlan(id: string, patch: PlanUpdateInput, ctx: CatalogActor, client: PrismaClient = defaultDb): Promise<PlanUpdateResult> {
  const result = await client.$transaction(async (tx) => {
    await lockPlan(tx, id);
    const current = await requirePlan(id, tx);
    const before = editableOf(current);
    const changed = changedKeys<keyof PlanEditable>(before, patch);
    if (changed.length === 0) return { plan: current, changed: false };
    const after: PlanEditable = { ...before };
    for (const key of changed) (after as Record<string, unknown>)[key] = patch[key];

    const issues = planRuleIssues({ ...after, type: current.type });
    if (issues.length > 0) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of issues) (fieldErrors[issue.path] ??= []).push(issue.message);
      throw errors.validation(fieldErrors);
    }

    const data: Prisma.PlanUpdateInput = {};
    for (const key of changed) (data as Record<string, unknown>)[key] = after[key];
    await tx.plan.update({ where: { id }, data });
    const { action, detail } = planChangeAudit(before, changed, after);
    await audit(tx, ctx.actor, {
      action,
      target: planAuditTarget(current.productName, after.name),
      targetType: "plan",
      targetId: id,
      detail,
    });
    return { plan: await requirePlan(id, tx), changed: true };
  });
  if (result.changed) revalidateCatalog();
  return result;
}

// ---------- Archive / restore ----------

/** Archive (can't be bought; existing licenses keep working and can still renew) or restore a plan. */
export async function setPlanArchived(id: string, archived: boolean, ctx: StatusChangeContext, client: PrismaClient = defaultDb): Promise<AdminPlanDetail> {
  const existing = await getPlanDetail(id, client);
  if (!existing) throw errors.notFound("Plan");
  await runDestructive(
    archived ? "plans.archive" : "plans.restore",
    {
      staff: ctx.staff,
      actor: ctx.actor,
      input: ctx.input,
      targetId: id,
      target: planAuditTarget(existing.productName, existing.name),
      targetType: "plan",
      client,
    },
    async (tx) => {
      await lockPlan(tx, id);
      const current = await tx.plan.findUniqueOrThrow({ where: { id }, select: { archived: true } });
      if (current.archived === archived) {
        throw errors.conflict(archived ? "already_archived" : "not_archived", archived ? PLAN_MESSAGES.alreadyArchived : PLAN_MESSAGES.notArchived);
      }
      await tx.plan.update({ where: { id }, data: { archived } });
    },
  );
  revalidateCatalog();
  return requirePlan(id, client);
}

export type BulkArchiveResult = { archived: string[]; skipped: string[] };

/**
 * Bulk "Archive" from the plans table: one transaction, one "Archived plan" audit row per plan that changed (plans
 * already archived are skipped). 422 when an id does not exist.
 */
export async function bulkArchivePlans(ids: readonly string[], ctx: StatusChangeContext, client: PrismaClient = defaultDb): Promise<BulkArchiveResult> {
  const unique = [...new Set(ids)];
  const { reason } = validateDestructive("plans.archive", { staff: ctx.staff, input: ctx.input, confirmValue: "" });
  const result = await client.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Plan" WHERE "id" = ANY(${unique}::text[]) ORDER BY "id" FOR UPDATE`;
    if (locked.length !== unique.length) throw errors.validation({ ids: PLAN_MESSAGES.bulkMissing });
    const plans = await tx.plan.findMany({ where: { id: { in: unique } }, include: planInclude, orderBy: { id: "asc" } });
    const archived: string[] = [];
    const skipped: string[] = [];
    for (const plan of plans) {
      if (plan.archived) {
        skipped.push(plan.id);
        continue;
      }
      await tx.plan.update({ where: { id: plan.id }, data: { archived: true } });
      await audit(tx, ctx.actor, {
        action: DESTRUCTIVE_AUDIT_ACTIONS["plans.archive"],
        target: planAuditTarget(plan.product.shortName, plan.name),
        targetType: "plan",
        targetId: plan.id,
        reason,
        detail: "Bulk archive",
      });
      archived.push(plan.id);
    }
    return { archived, skipped };
  });
  if (result.archived.length > 0) revalidateCatalog();
  return result;
}
