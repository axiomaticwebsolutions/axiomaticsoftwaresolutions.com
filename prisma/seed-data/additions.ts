/**
 * Versioned, insert-only catalog additions (decisions.md 2026-10-09 "Catalog additions").
 *
 * The production bootstrap writes the catalog once (its first run), so products added to the code later never reach a
 * database that is already live. An addition is a named set of categories and products that the bootstrap creates
 * exactly once on any database, new or existing:
 * - it runs when no AuditLog row marks it done (targetType "system", targetId "catalog-addition:<id>");
 * - it only INSERTS: categories and products that already exist (by id) are left exactly as they are, whatever the
 *   owner changed; a product whose license prefix (code) or category is missing or taken is skipped and reported;
 * - it then writes its marker row (also when nothing was missing), so rows the owner later edits, re-categorises or
 *   deletes are never touched or re-created by a later run;
 * - it never writes plans, releases, FAQs, settings, counters or users.
 * Ids are permanent: never rename or reuse one. A new set of products gets a new addition with a new id.
 *
 * Runs inside the bootstrap's transaction (planBootstrap/applyBootstrap), or alone with runCatalogAdditions()
 * (`scripts/bootstrap-production.ts --additions-only`, which also works on a development database).
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { Db, Tx } from "@/lib/db";
import { formatDateIST } from "@/lib/dates";
import { CATEGORIES, categorySortOrder } from "./catalog";
import { COMING_SOON_PRODUCT_IDS, comingSoonProductRow, findComingSoonProduct } from "./coming-soon";
import type { WithId } from "./types";

export type AdditionCategoryRow = WithId<Prisma.CategoryCreateManyInput>;
export type AdditionProductRow = WithId<Prisma.ProductCreateManyInput> & { code: string; categoryId: string };

export type CatalogAddition = {
  /** Permanent: the marker `catalog-addition:<id>` records that it ran. */
  id: string;
  /** What it adds (report and audit row). */
  title: string;
  categoryIds: readonly string[];
  productIds: readonly string[];
};

/** In the order they were introduced; each runs once per database. */
export const CATALOG_ADDITIONS: readonly CatalogAddition[] = [
  {
    id: "2026-10-09-coming-soon",
    title: "Coming-soon catalog (3 categories, 20 products)",
    categoryIds: ["jewellery", "wholesale", "industry"],
    productIds: COMING_SOON_PRODUCT_IDS,
  },
];

/** pg_advisory_xact_lock key ("AXSB"), shared with the bootstrap: a second run waits for the first instead of racing it. */
export const BOOTSTRAP_LOCK_KEY = 1096307522;
export const ADDITIONS_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

export const ADDITION_AUDIT = { targetType: "system", action: "Added catalog products", markerPrefix: "catalog-addition:" } as const;

export function additionMarkerId(id: string): string {
  return `${ADDITION_AUDIT.markerPrefix}${id}`;
}

export type AdditionRows = { id: string; title: string; categories: AdditionCategoryRow[]; products: AdditionProductRow[] };

/** The rows of each addition (pure). Throws for an id the catalog modules do not define. */
export function buildAdditionRows(additions: readonly CatalogAddition[] = CATALOG_ADDITIONS): AdditionRows[] {
  return additions.map((a) => ({
    id: a.id,
    title: a.title,
    categories: a.categoryIds.map((id) => {
      const c = CATEGORIES.find((x) => x.id === id);
      if (!c) throw new RangeError(`Catalog addition ${a.id}: unknown category ${id}`);
      return { id: c.id, name: c.name, blurb: c.blurb, tone: c.tone, icon: c.icon, sortOrder: categorySortOrder(c.id) };
    }),
    products: a.productIds.map((id) => {
      const p = findComingSoonProduct(id);
      if (!p) throw new RangeError(`Catalog addition ${a.id}: unknown product ${id}`);
      return comingSoonProductRow(p) as AdditionProductRow;
    }),
  }));
}

/** Category ids an addition owns: the bootstrap's own catalog step leaves them to the addition. */
export function additionCategoryIds(additions: readonly CatalogAddition[] = CATALOG_ADDITIONS): ReadonlySet<string> {
  return new Set(additions.flatMap((a) => a.categoryIds));
}

export type AdditionSkip = { kind: "category" | "product"; id: string; reason: string };

export type AdditionPlan = {
  id: string;
  title: string;
  /** When its marker was written; null = pending (this run applies it). */
  doneAt: Date | null;
  categories: { create: AdditionCategoryRow[]; kept: string[] };
  products: { create: AdditionProductRow[]; kept: string[] };
  skipped: AdditionSkip[];
};

/** Rows the same run creates before the additions (the bootstrap's first catalog step), so FKs and codes resolve. */
export type PlannedCatalog = {
  categoryIds: ReadonlySet<string>;
  productIds: ReadonlySet<string>;
  /** License prefix -> product id. */
  productCodes: ReadonlyMap<string, string>;
};

export const NOTHING_PLANNED: PlannedCatalog = { categoryIds: new Set(), productIds: new Set(), productCodes: new Map() };

/**
 * Reads the database and decides what each addition creates (writes nothing). Done additions are reported with the
 * date of their marker and plan nothing. Pending ones are planned in order; a later one sees what an earlier one creates.
 */
export async function planCatalogAdditions(db: Db, rows: readonly AdditionRows[], planned: PlannedCatalog = NOTHING_PLANNED): Promise<AdditionPlan[]> {
  // Sequential on purpose: inside an interactive transaction pg runs one query at a time anyway.
  const markers = await db.auditLog.findMany({
    where: { targetType: ADDITION_AUDIT.targetType, targetId: { in: rows.map((r) => additionMarkerId(r.id)) } },
    orderBy: { createdAt: "asc" },
    select: { targetId: true, createdAt: true },
  });
  const doneAt = new Map<string, Date>();
  for (const m of markers) if (m.targetId && !doneAt.has(m.targetId)) doneAt.set(m.targetId, m.createdAt);

  const categoryIds = new Set(planned.categoryIds);
  const productIds = new Set(planned.productIds);
  const codes = new Map(planned.productCodes);
  const out: AdditionPlan[] = [];
  for (const addition of rows) {
    const done = doneAt.get(additionMarkerId(addition.id)) ?? null;
    const plan: AdditionPlan = { id: addition.id, title: addition.title, doneAt: done, categories: { create: [], kept: [] }, products: { create: [], kept: [] }, skipped: [] };
    out.push(plan);
    if (done) continue;

    const neededCategories = [...new Set([...addition.categories.map((c) => c.id), ...addition.products.map((p) => p.categoryId)])];
    const storedCategories = await db.category.findMany({ where: { id: { in: neededCategories } }, select: { id: true } });
    for (const c of storedCategories) categoryIds.add(c.id);
    for (const c of addition.categories) {
      if (categoryIds.has(c.id)) plan.categories.kept.push(c.id);
      else {
        plan.categories.create.push(c);
        categoryIds.add(c.id);
      }
    }

    const relatedIds = addition.products.flatMap((p) => p.relatedIds as string[]);
    const lookupIds = [...new Set([...addition.products.map((p) => p.id), ...relatedIds])];
    const storedById = await db.product.findMany({ where: { id: { in: lookupIds } }, select: { id: true } });
    for (const p of storedById) productIds.add(p.id);
    const storedCodes = await db.product.findMany({ where: { code: { in: addition.products.map((p) => p.code) } }, select: { id: true, code: true } });
    for (const p of storedCodes) codes.set(p.code, p.id);

    for (const p of addition.products) {
      if (productIds.has(p.id)) {
        plan.products.kept.push(p.id);
        continue;
      }
      const owner = codes.get(p.code);
      if (owner !== undefined && owner !== p.id) {
        plan.skipped.push({ kind: "product", id: p.id, reason: `license prefix ${p.code} already belongs to product "${owner}"` });
        continue;
      }
      if (!categoryIds.has(p.categoryId)) {
        plan.skipped.push({ kind: "product", id: p.id, reason: `its category "${p.categoryId}" does not exist` });
        continue;
      }
      plan.products.create.push(p);
      productIds.add(p.id);
      codes.set(p.code, p.id);
    }
    // Related products must exist after this run (a skipped or missing one is dropped from the list).
    plan.products.create = plan.products.create.map((p) => ({ ...p, relatedIds: (p.relatedIds as string[]).filter((id) => id !== p.id && productIds.has(id)) }));
  }
  return out;
}

export function pendingAdditions(plans: readonly AdditionPlan[]): AdditionPlan[] {
  return plans.filter((p) => p.doneAt === null);
}

function additionDetail(plan: AdditionPlan): string {
  const parts = [`${plan.title}.`, `Created ${plan.categories.create.length} categories and ${plan.products.create.length} products (Coming soon).`];
  const kept = [...plan.categories.kept, ...plan.products.kept];
  if (kept.length > 0) parts.push(`Already there, left unchanged: ${kept.join(", ")}.`);
  if (plan.skipped.length > 0) parts.push(`Skipped: ${plan.skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}.`);
  return parts.join(" ");
}

/**
 * Writes the pending additions inside the caller's transaction: categories, then products (ON CONFLICT DO NOTHING, so a
 * row created meanwhile is kept as it is), then one marker AuditLog row per addition (actor "system").
 */
export async function applyCatalogAdditions(tx: Tx, plans: readonly AdditionPlan[]): Promise<void> {
  for (const plan of pendingAdditions(plans)) {
    if (plan.categories.create.length > 0) await tx.category.createMany({ data: plan.categories.create, skipDuplicates: true });
    if (plan.products.create.length > 0) await tx.product.createMany({ data: plan.products.create, skipDuplicates: true });
    await tx.auditLog.create({
      data: {
        actorId: null,
        actorRole: "system",
        action: ADDITION_AUDIT.action,
        target: `Catalog addition ${plan.id}`,
        targetType: ADDITION_AUDIT.targetType,
        targetId: additionMarkerId(plan.id),
        detail: additionDetail(plan),
        ipPrefix: null,
      },
    });
  }
}

/**
 * Plans and applies every pending addition in ONE transaction after the bootstrap's advisory lock. A dry run plans in a
 * READ ONLY transaction (Postgres refuses any write). No dev-seed check and no Owner check: it only inserts catalog rows.
 */
export async function runCatalogAdditions(
  db: PrismaClient,
  input: { dryRun: boolean; rows?: readonly AdditionRows[] },
): Promise<AdditionPlan[]> {
  const rows = input.rows ?? buildAdditionRows();
  if (input.dryRun) {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return planCatalogAdditions(tx, rows);
    }, ADDITIONS_TX_OPTIONS);
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY}::bigint)::text AS "locked"`;
    const plans = await planCatalogAdditions(tx, rows);
    await applyCatalogAdditions(tx, plans);
    return plans;
  }, ADDITIONS_TX_OPTIONS);
}

/** Report lines (ids and names only). `applied`: false for a dry run ("would add"). */
export function formatAdditionLines(plans: readonly AdditionPlan[], applied: boolean): string[] {
  const lines: string[] = [];
  for (const plan of plans) {
    if (plan.doneAt) {
      lines.push(`  Catalog addition ${plan.id}: already added on ${formatDateIST(plan.doneAt)}; nothing to do.`);
      continue;
    }
    const verb = applied ? "added" : "would add";
    lines.push(`  Catalog addition ${plan.id} - ${plan.title}: ${verb} ${plan.categories.create.length} categories, ${plan.products.create.length} products.`);
    for (const c of plan.categories.create) lines.push(`    + category ${c.id} "${c.name}"`);
    for (const p of plan.products.create) lines.push(`    + product ${p.id} "${p.name}" (${p.code}, Coming soon, category ${p.categoryId})`);
    const kept = [...plan.categories.kept.map((id) => `category ${id}`), ...plan.products.kept.map((id) => `product ${id}`)];
    if (kept.length > 0) lines.push(`    = already there, left unchanged: ${kept.join(", ")}`);
    for (const s of plan.skipped) lines.push(`    ! skipped ${s.kind} ${s.id}: ${s.reason}`);
    lines.push(`    ${applied ? "Recorded" : "Will record"} as done: it never runs again on this database.`);
  }
  return lines;
}
