/**
 * Admin Products & categories (Admin Console.dc.html #products; api-contracts section 7; decisions.md Phase 6):
 * product list, detail, create (DRAFT), listing and content edits, publish / hide / mark coming soon (destructive:
 * reason, one audit row in the same transaction), and category CRUD. Product codes are immutable once licenses exist.
 * Every write is audited and revalidates the storefront catalog cache after commit.
 *
 * The catalog is small (tens of products), so lists are filtered in SQL and sorted in memory, which lets them sort by
 * derived values (latest version, "From" price). Server-only; routes authorize first.
 */
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishStatus } from "@/generated/prisma/enums";
import { pageResult, searchWhere, type ListPage } from "@/lib/admin/list-query";
import { runDestructive, type DestructiveInput } from "@/lib/admin/destructive";
import { audit, type AuditActor } from "@/lib/audit";
import { productContentSchema } from "@/lib/catalog/content";
import { db as defaultDb, type Prisma, type Tx } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { compareVersions } from "@/lib/licensing/entitlement";
import type { StaffRole } from "@/generated/prisma/enums";
import type { CatalogListQuery, ProductSort } from "./list-config";
import { readProductContent } from "./model";
import { revalidateCatalog } from "./revalidate";
import {
  CUSTOMER_CHANNEL,
  changedKeys,
  isMainPlanType,
  latestReleaseIds,
  productChangeSummary,
  productComingSoonBlockers,
  productPublishBlockers,
  type ProductFieldKey,
} from "./rules";
import type { CategoryCreateInput, CategoryUpdateInput, ProductCreateInput, ProductUpdateInput } from "./schemas";
import type {
  AdminCategoryRow,
  AdminProductDetail,
  AdminProductRow,
  CatalogFormOptions,
  CatalogPlatform,
  CatalogTone,
  PlanTypeKey,
  ProductStatusKey,
} from "./types";

export type ProductFilterKey = "category" | "status";
export type ProductListQuery = CatalogListQuery<ProductFilterKey, ProductSort>;

export const PRODUCT_MESSAGES = {
  idTaken: "A product with this id already exists.",
  codeTaken: "Another product already uses this license prefix.",
  codeLocked: "The license prefix can\u2019t change after licenses have been issued for this product.",
  category: "Choose a category.",
  relatedSelf: "A product can\u2019t be related to itself.",
  relatedUnknown: "Choose products from the list.",
  alreadyPublished: "This product is already published.",
  notPublished: "Only a published or coming-soon product can be hidden.",
  alreadyComingSoon: "This product is already marked coming soon.",
  publishedNotComingSoon: "A published product can\u2019t be marked coming soon. Hide it first if it was published by mistake.",
  categoryIdTaken: "A category with this id already exists.",
  categoryInUse: (n: number) => `Move its ${n === 1 ? "product" : `${n} products`} to another category first.`,
} as const;

const listInclude = {
  category: { select: { name: true } },
  plans: { where: { archived: false }, select: { type: true, pricePaise: true } },
  releases: {
    where: { status: "PUBLISHED", channel: CUSTOMER_CHANNEL },
    select: { id: true, productId: true, version: true, releasedAt: true, channel: true, status: true },
  },
} satisfies Prisma.ProductInclude;

type ListProduct = Prisma.ProductGetPayload<{ include: typeof listInclude }>;

const PLATFORM_ORDER: readonly CatalogPlatform[] = ["windows", "macos", "android"];

function platformsOf(values: readonly string[]): CatalogPlatform[] {
  return PLATFORM_ORDER.filter((p) => values.includes(p));
}

function statusKey(status: PublishStatus): ProductStatusKey {
  return status;
}

function latestOf(p: Pick<ListProduct, "releases">): { version: string; releasedAt: string } | null {
  const id = latestReleaseIds(p.releases).values().next().value;
  const r = p.releases.find((x) => x.id === id);
  return r && r.releasedAt ? { version: r.version, releasedAt: r.releasedAt.toISOString() } : null;
}

/** The storefront "From": cheapest paid main plan on sale. */
function fromPrice(plans: readonly { type: PlanTypeKey; pricePaise: number }[]): number | null {
  let best: number | null = null;
  for (const plan of plans) {
    if (!isMainPlanType(plan.type) || plan.pricePaise <= 0) continue;
    if (best === null || plan.pricePaise < best) best = plan.pricePaise;
  }
  return best;
}

function toRow(p: ListProduct): AdminProductRow {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    shortName: p.shortName,
    categoryId: p.categoryId,
    categoryName: p.category.name,
    platforms: platformsOf(p.platforms),
    status: statusKey(p.status),
    rank: p.rank,
    latest: latestOf(p),
    planCount: p.plans.length,
    fromPricePaise: fromPrice(p.plans),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function nullsLast<T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b);
}

const byName = (a: AdminProductRow, b: AdminProductRow) => a.name.localeCompare(b.name, "en-IN");

/** In-memory order for the product table (ties: name, then id). Missing values sort last in both directions. */
export function sortProductRows(rows: AdminProductRow[], sort: { id: ProductSort; desc: boolean }): AdminProductRow[] {
  const dir = sort.desc ? -1 : 1;
  const primary = (a: AdminProductRow, b: AdminProductRow): number => {
    switch (sort.id) {
      case "name":
        return dir * byName(a, b);
      case "latest":
        return nullsLast(a.latest, b.latest, (x, y) => dir * compareVersions(x.version, y.version));
      case "price":
        return nullsLast(a.fromPricePaise, b.fromPricePaise, (x, y) => dir * (x - y));
      case "rank":
        return dir * (a.rank - b.rank);
    }
  };
  return [...rows].sort((a, b) => primary(a, b) || byName(a, b) || a.id.localeCompare(b.id));
}

function productWhere(query: Pick<ProductListQuery, "q" | "filters">): Prisma.ProductWhereInput {
  const status = query.filters.status?.toUpperCase();
  return {
    ...(query.filters.category ? { categoryId: query.filters.category } : {}),
    ...(status === "PUBLISHED" || status === "HIDDEN" || status === "DRAFT" || status === "COMING_SOON" ? { status } : {}),
    ...(searchWhere<Prisma.ProductWhereInput>(query.q, ["name", "shortName", "code", "id", "category.name"]) ?? {}),
  };
}

/** Every product matching the search and filters, sorted (exports and the paged list). */
export async function productRows(query: Pick<ProductListQuery, "q" | "filters" | "sort">, client: PrismaClient = defaultDb): Promise<AdminProductRow[]> {
  const products = await client.product.findMany({ where: productWhere(query), include: listInclude });
  return sortProductRows(products.map(toRow), query.sort);
}

export async function listProducts(query: ProductListQuery, client: PrismaClient = defaultDb): Promise<ListPage<AdminProductRow>> {
  const rows = await productRows(query, client);
  const start = (query.page - 1) * query.pageSize;
  return pageResult(rows.slice(start, start + query.pageSize), rows.length, query);
}

// ---------- Detail ----------

const detailInclude = {
  category: { select: { name: true } },
  plans: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
  releases: {
    where: { status: "PUBLISHED", channel: CUSTOMER_CHANNEL },
    select: { id: true, productId: true, version: true, releasedAt: true, channel: true, status: true, files: { select: { id: true } } },
  },
} satisfies Prisma.ProductInclude;

type DetailProduct = Prisma.ProductGetPayload<{ include: typeof detailInclude }>;

function toDetail(p: DetailProduct, codeLocked: boolean, hasOrders: boolean, waitlistCount: number): AdminProductDetail {
  const onSale = p.plans.filter((plan) => !plan.archived);
  const content = readProductContent(p.content);
  const contentValid = productContentSchema.safeParse(p.content).success;
  const publishable = p.releases.filter((r) => r.files.length > 0);
  return {
    ...toRow({ ...p, plans: onSale, releases: p.releases }),
    tagline: p.tagline,
    summary: p.summary,
    icon: p.icon,
    tone: (p.tone as CatalogTone | null) ?? null,
    demoEnabled: p.demoEnabled,
    content,
    contentValid,
    relatedIds: p.relatedIds,
    hasTrial: onSale.some((plan) => plan.type === "TRIAL"),
    codeLocked,
    plans: p.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      type: plan.type,
      multiDevice: plan.multiDevice,
      deviceLimit: plan.deviceLimit,
      perUnit: plan.perUnit,
      pricePaise: plan.pricePaise,
      archived: plan.archived,
    })),
    publishBlockers:
      p.status === "PUBLISHED"
        ? []
        : productPublishBlockers({
            contentValid,
            mainPlansOnSale: onSale.filter((plan) => isMainPlanType(plan.type)).length,
            publishedStableReleases: publishable.length,
          }),
    comingSoonBlockers:
      p.status === "COMING_SOON"
        ? []
        : productComingSoonBlockers({
            status: p.status,
            name: p.name,
            tagline: p.tagline,
            summary: p.summary,
            categoryId: p.categoryId,
            icon: p.icon,
            contentValid,
            hasLicenses: codeLocked,
            hasOrders,
          }),
    waitlistCount,
    createdAt: p.createdAt.toISOString(),
  };
}

async function hasLicenses(client: PrismaClient | Tx, productId: string): Promise<boolean> {
  return (await client.license.findFirst({ where: { productId }, select: { id: true } })) !== null;
}

/** Whether any order (any status) has an item for one of these plans: such a product has been sold. */
async function hasOrders(client: PrismaClient | Tx, planIds: readonly string[]): Promise<boolean> {
  if (planIds.length === 0) return false;
  return (await client.orderItem.findFirst({ where: { planId: { in: [...planIds] } }, select: { id: true } })) !== null;
}

/** The product drawer, or null for an unknown id. */
export async function getProductDetail(id: string, client: PrismaClient | Tx = defaultDb): Promise<AdminProductDetail | null> {
  const product = await client.product.findUnique({ where: { id }, include: detailInclude });
  if (!product) return null;
  const waitlist = await client.lead.count({ where: { kind: "WAITLIST", productId: id } });
  const ordered = await hasOrders(client, product.plans.map((plan) => plan.id));
  return toDetail(product, await hasLicenses(client, id), ordered, waitlist);
}

async function requireDetail(id: string, client: PrismaClient | Tx): Promise<AdminProductDetail> {
  const detail = await getProductDetail(id, client);
  if (!detail) throw errors.notFound("Product");
  return detail;
}

// ---------- Create and edit ----------

export type CatalogActor = { actor: AuditActor };

function isUniqueViolation(e: unknown, field?: string): boolean {
  const err = e as { code?: unknown; meta?: { target?: unknown } } | null;
  if (err?.code !== "P2002") return false;
  if (!field) return true;
  const target = err.meta?.target;
  return Array.isArray(target) ? target.includes(field) : typeof target === "string" ? target.includes(field) : true;
}

async function assertCategory(tx: Tx, categoryId: string): Promise<void> {
  const found = await tx.category.findUnique({ where: { id: categoryId }, select: { id: true } });
  if (!found) throw errors.validation({ categoryId: PRODUCT_MESSAGES.category });
}

async function assertRelated(tx: Tx, productId: string, relatedIds: readonly string[]): Promise<void> {
  if (relatedIds.includes(productId)) throw errors.validation({ relatedIds: PRODUCT_MESSAGES.relatedSelf });
  if (relatedIds.length === 0) return;
  const found = await tx.product.count({ where: { id: { in: [...relatedIds] } } });
  if (found !== relatedIds.length) throw errors.validation({ relatedIds: PRODUCT_MESSAGES.relatedUnknown });
}

const EMPTY_CONTENT = { features: [], benefits: [], requirements: [] };

/** New DRAFT product (empty page content; add plans and a release before publishing). 422 for a taken id or code. */
export async function createProduct(input: ProductCreateInput, ctx: CatalogActor, client: PrismaClient = defaultDb): Promise<AdminProductDetail> {
  let detail: AdminProductDetail;
  try {
    detail = await client.$transaction(async (tx) => {
      if (await tx.product.findUnique({ where: { id: input.id }, select: { id: true } })) {
        throw errors.validation({ id: PRODUCT_MESSAGES.idTaken });
      }
      if (await tx.product.findUnique({ where: { code: input.code }, select: { id: true } })) {
        throw errors.validation({ code: PRODUCT_MESSAGES.codeTaken });
      }
      await assertCategory(tx, input.categoryId);
      await tx.product.create({
        data: {
          id: input.id,
          code: input.code,
          name: input.name,
          shortName: input.shortName,
          tagline: input.tagline,
          summary: input.summary,
          icon: input.icon,
          tone: input.tone,
          categoryId: input.categoryId,
          platforms: input.platforms,
          status: "DRAFT",
          demoEnabled: input.demoEnabled,
          rank: input.rank,
          content: EMPTY_CONTENT,
          relatedIds: [],
        },
      });
      await audit(tx, ctx.actor, {
        action: "Created product",
        target: input.name,
        targetType: "product",
        targetId: input.id,
        detail: `Draft \u00B7 license prefix ${input.code}`,
      });
      return requireDetail(input.id, tx);
    });
  } catch (e) {
    if (isUniqueViolation(e, "code")) throw errors.validation({ code: PRODUCT_MESSAGES.codeTaken });
    if (isUniqueViolation(e)) throw errors.validation({ id: PRODUCT_MESSAGES.idTaken });
    throw e;
  }
  revalidateCatalog();
  return detail;
}

async function lockProduct(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Product" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw errors.notFound("Product");
}

export type ProductUpdateResult = { product: AdminProductDetail; changed: boolean };

/**
 * Listing, content and related-product edits. Values equal to the stored ones are ignored; with nothing left to change
 * it answers `changed: false` without an audit row ("No changes to save"). The code (license prefix) cannot change
 * once licenses exist (409 `code_locked`).
 */
export async function updateProduct(
  id: string,
  patch: ProductUpdateInput,
  ctx: CatalogActor,
  client: PrismaClient = defaultDb,
): Promise<ProductUpdateResult> {
  let result: ProductUpdateResult;
  try {
    result = await client.$transaction(async (tx) => {
      await lockProduct(tx, id);
      const current = await tx.product.findUniqueOrThrow({ where: { id } });
      const before: Record<ProductFieldKey, unknown> & { code: string } = {
        code: current.code,
        name: current.name,
        shortName: current.shortName,
        tagline: current.tagline,
        summary: current.summary,
        categoryId: current.categoryId,
        platforms: platformsOf(current.platforms),
        icon: current.icon,
        tone: current.tone,
        rank: current.rank,
        demoEnabled: current.demoEnabled,
        content: current.content,
        relatedIds: current.relatedIds,
      };
      const changed = changedKeys<ProductFieldKey>(before, patch);
      if (changed.length === 0) return { product: await requireDetail(id, tx), changed: false };

      if (changed.includes("code") && patch.code) {
        if (await hasLicenses(tx, id)) throw errors.conflict("code_locked", PRODUCT_MESSAGES.codeLocked);
        const taken = await tx.product.findUnique({ where: { code: patch.code }, select: { id: true } });
        if (taken && taken.id !== id) throw errors.validation({ code: PRODUCT_MESSAGES.codeTaken });
      }
      if (changed.includes("categoryId") && patch.categoryId) await assertCategory(tx, patch.categoryId);
      if (changed.includes("relatedIds") && patch.relatedIds) await assertRelated(tx, id, patch.relatedIds);

      const data: Prisma.ProductUpdateInput = {};
      for (const key of changed) {
        if (key === "categoryId") data.category = { connect: { id: patch.categoryId } };
        else if (key === "content") data.content = patch.content as Prisma.InputJsonValue;
        else (data as Record<string, unknown>)[key] = patch[key];
      }
      await tx.product.update({ where: { id }, data });
      await audit(tx, ctx.actor, {
        action: "Updated product listing",
        target: patch.name ?? current.name,
        targetType: "product",
        targetId: id,
        detail: productChangeSummary(before, changed, { code: patch.code }),
      });
      return { product: await requireDetail(id, tx), changed: true };
    });
  } catch (e) {
    if (isUniqueViolation(e, "code")) throw errors.validation({ code: PRODUCT_MESSAGES.codeTaken });
    throw e;
  }
  if (result.changed) revalidateCatalog();
  return result;
}

export type StatusChangeContext = {
  staff: { id: string; role: StaffRole };
  actor: AuditActor;
  input: DestructiveInput;
};

export type ProductStatusAction = "publish" | "hide" | "coming_soon";

const STATUS_WORD: Record<ProductStatusKey, string> = { DRAFT: "Draft", HIDDEN: "Hidden", PUBLISHED: "Published", COMING_SOON: "Coming soon" };
const ACTION_TARGET: Record<ProductStatusAction, ProductStatusKey> = { publish: "PUBLISHED", hide: "HIDDEN", coming_soon: "COMING_SOON" };
const ACTION_RULE = { publish: "products.publish", hide: "products.hide", coming_soon: "products.coming_soon" } as const;

/**
 * Publish (from DRAFT, HIDDEN or COMING_SOON; 409 `not_ready` with `blockers` while the page content, a plan on sale or
 * a published release is missing), hide (from PUBLISHED or COMING_SOON) or mark coming soon (from DRAFT or HIDDEN; 409
 * `not_ready` with `blockers` while the storefront copy is incomplete or licenses exist; plans and releases are not
 * needed) a product. Destructive rule: reason required, exactly one audit row ("Published product" / "Hid product" /
 * "Marked product coming soon", detail "Draft → Coming soon") in the same transaction.
 */
export async function setProductStatus(
  id: string,
  action: ProductStatusAction,
  ctx: StatusChangeContext,
  client: PrismaClient = defaultDb,
): Promise<AdminProductDetail> {
  const existing = await client.product.findUnique({ where: { id }, select: { name: true } });
  if (!existing) throw errors.notFound("Product");
  const to = ACTION_TARGET[action];
  await runDestructive(
    ACTION_RULE[action],
    {
      staff: ctx.staff,
      actor: ctx.actor,
      input: ctx.input,
      targetId: id,
      target: existing.name,
      targetType: "product",
      detail: (d: { from: string }) => `${d.from} \u2192 ${STATUS_WORD[to]}`,
      client,
    },
    async (tx) => {
      await lockProduct(tx, id);
      const current = await requireDetail(id, tx);
      const notReady = (blockers: string[]) => new ApiError(409, "not_ready", blockers.join(" "), { details: { blockers } });
      if (action === "publish") {
        if (current.status === "PUBLISHED") throw errors.conflict("already_published", PRODUCT_MESSAGES.alreadyPublished);
        if (current.publishBlockers.length > 0) throw notReady(current.publishBlockers);
      } else if (action === "hide") {
        if (current.status !== "PUBLISHED" && current.status !== "COMING_SOON") throw errors.conflict("not_published", PRODUCT_MESSAGES.notPublished);
      } else {
        if (current.status === "COMING_SOON") throw errors.conflict("already_coming_soon", PRODUCT_MESSAGES.alreadyComingSoon);
        if (current.status === "PUBLISHED") throw errors.conflict("published", PRODUCT_MESSAGES.publishedNotComingSoon);
        if (current.comingSoonBlockers.length > 0) throw notReady(current.comingSoonBlockers);
      }
      await tx.product.update({ where: { id }, data: { status: to } });
      return { from: STATUS_WORD[current.status] };
    },
  );
  revalidateCatalog();
  return requireDetail(id, client);
}

// ---------- Categories ----------

type CategoryRecord = { id: string; name: string; blurb: string | null; tone: string; icon: string; sortOrder: number };

type CategoryCounts = { total: number; published: number; comingSoon: number };

async function categoryCounts(client: PrismaClient | Tx): Promise<Map<string, CategoryCounts>> {
  const groups = await client.product.groupBy({ by: ["categoryId", "status"], _count: { _all: true } });
  const out = new Map<string, CategoryCounts>();
  for (const g of groups) {
    const entry = out.get(g.categoryId) ?? { total: 0, published: 0, comingSoon: 0 };
    entry.total += g._count._all;
    if (g.status === "PUBLISHED") entry.published += g._count._all;
    if (g.status === "COMING_SOON") entry.comingSoon += g._count._all;
    out.set(g.categoryId, entry);
  }
  return out;
}

function toCategoryRow(c: CategoryRecord, counts: Map<string, CategoryCounts>): AdminCategoryRow {
  const n = counts.get(c.id) ?? { total: 0, published: 0, comingSoon: 0 };
  return {
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    tone: c.tone as CatalogTone,
    icon: c.icon,
    sortOrder: c.sortOrder,
    productCount: n.total,
    publishedCount: n.published,
    comingSoonCount: n.comingSoon,
  };
}

/** Every category in storefront order (sort order, then name), with product counts. */
export async function listCategories(client: PrismaClient | Tx = defaultDb, q = ""): Promise<AdminCategoryRow[]> {
  const [categories, counts] = await Promise.all([
    client.category.findMany({
      where: searchWhere<Prisma.CategoryWhereInput>(q, ["name", "id"]),
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
    }),
    categoryCounts(client),
  ]);
  return categories.map((c) => toCategoryRow(c, counts));
}

async function requireCategoryRow(id: string, client: PrismaClient | Tx): Promise<AdminCategoryRow> {
  const c = await client.category.findUnique({ where: { id } });
  if (!c) throw errors.notFound("Category");
  return toCategoryRow(c, await categoryCounts(client));
}

export async function getCategory(id: string, client: PrismaClient | Tx = defaultDb): Promise<AdminCategoryRow | null> {
  const c = await client.category.findUnique({ where: { id } });
  return c ? toCategoryRow(c, await categoryCounts(client)) : null;
}

export async function createCategory(input: CategoryCreateInput, ctx: CatalogActor, client: PrismaClient = defaultDb): Promise<AdminCategoryRow> {
  let row: AdminCategoryRow;
  try {
    row = await client.$transaction(async (tx) => {
      if (await tx.category.findUnique({ where: { id: input.id }, select: { id: true } })) {
        throw errors.validation({ id: PRODUCT_MESSAGES.categoryIdTaken });
      }
      await tx.category.create({ data: input });
      await audit(tx, ctx.actor, { action: "Created category", target: input.name, targetType: "category", targetId: input.id });
      return requireCategoryRow(input.id, tx);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw errors.validation({ id: PRODUCT_MESSAGES.categoryIdTaken });
    throw e;
  }
  revalidateCatalog();
  return row;
}

const CATEGORY_FIELD_LABELS: Record<keyof CategoryUpdateInput, string> = {
  name: "Name",
  blurb: "Description",
  tone: "Colour",
  icon: "Icon",
  sortOrder: "Sort order",
};

export async function updateCategory(
  id: string,
  patch: CategoryUpdateInput,
  ctx: CatalogActor,
  client: PrismaClient = defaultDb,
): Promise<{ category: AdminCategoryRow; changed: boolean }> {
  const result = await client.$transaction(async (tx) => {
    const current = await tx.category.findUnique({ where: { id } });
    if (!current) throw errors.notFound("Category");
    const changed = changedKeys<keyof CategoryUpdateInput>(current, patch);
    if (changed.length === 0) return { category: await requireCategoryRow(id, tx), changed: false };
    const data: Prisma.CategoryUpdateInput = {};
    for (const key of changed) (data as Record<string, unknown>)[key] = patch[key];
    await tx.category.update({ where: { id }, data });
    await audit(tx, ctx.actor, {
      action: "Updated category",
      target: patch.name ?? current.name,
      targetType: "category",
      targetId: id,
      detail: changed.map((k) => CATEGORY_FIELD_LABELS[k]).join(", "),
    });
    return { category: await requireCategoryRow(id, tx), changed: true };
  });
  if (result.changed) revalidateCatalog();
  return result;
}

/**
 * Deletes an empty category (409 `category_in_use` while products belong to it). Destructive rule "categories.delete":
 * a reason (422 `reason_required`) and exactly one audit row "Deleted category" in the same transaction.
 */
export async function deleteCategory(id: string, ctx: StatusChangeContext, client: PrismaClient = defaultDb): Promise<void> {
  const existing = await client.category.findUnique({ where: { id }, select: { name: true } });
  if (!existing) throw errors.notFound("Category");
  await runDestructive(
    "categories.delete",
    { staff: ctx.staff, actor: ctx.actor, input: ctx.input, targetId: id, target: existing.name, targetType: "category", client },
    async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; name: string }[]>`SELECT "id", "name" FROM "Category" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows[0]) throw errors.notFound("Category");
      const products = await tx.product.count({ where: { categoryId: id } });
      if (products > 0) throw errors.conflict("category_in_use", PRODUCT_MESSAGES.categoryInUse(products), { productCount: products });
      await tx.category.delete({ where: { id } });
    },
  );
  revalidateCatalog();
}

// ---------- Form options ----------

/** Category and product choices for the catalog forms and filters (every status). */
export async function catalogFormOptions(client: PrismaClient = defaultDb): Promise<CatalogFormOptions> {
  const [categories, products] = await Promise.all([
    client.category.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, tone: true } }),
    client.product.findMany({
      orderBy: [{ rank: "asc" }, { name: "asc" }],
      select: { id: true, name: true, shortName: true, code: true, platforms: true },
    }),
  ]);
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, tone: c.tone as CatalogTone })),
    products: products.map((p) => ({ id: p.id, name: p.shortName, code: p.code, platforms: platformsOf(p.platforms) })),
  };
}
