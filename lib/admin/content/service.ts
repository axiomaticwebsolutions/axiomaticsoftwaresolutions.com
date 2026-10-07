/**
 * Admin Content & FAQs service (decisions.md Phase 6 "Content"; api-contracts section 7 "faqs, settings/banner: CRUD").
 * Server-only. Every write is one transaction with its audit row, then the storefront caches are revalidated
 * (`faqs` for FAQs, which also refreshes product pages; `settings` for the banner and the sample notice).
 */
import "server-only";
import type { Faq, StaffRole } from "@/generated/prisma/client";
import { runDestructive, type DestructiveInput } from "@/lib/admin/destructive";
import { pageResult, type ListPage } from "@/lib/admin/list-query";
import { audit, type AuditActor } from "@/lib/audit";
import { parseStoredSetting, settingSchemas } from "@/lib/config";
import { db, type Db, type Tx } from "@/lib/db";
import { errors } from "@/lib/http";
import {
  CONTENT_NOTICE_KEYS,
  FAQ_ERRORS,
  faqPageLabel,
  faqPageOptions,
  filterAndSortFaqs,
  type ContentNoticeDto,
  type ContentNoticeKey,
  type FaqDto,
  type FaqListQuery,
  type FaqPageOption,
} from "./model";
import { revalidateStorefront } from "./revalidate";
import type { FaqBulkInput, FaqCreateInput, FaqMoveInput, FaqUpdateInput, NoticePatchInput } from "./schemas";

export type ContentActorContext = { actor: AuditActor };
export type ContentStaffContext = { staff: { id: string; role: StaffRole }; actor: AuditActor };

/** Gap between sortOrder values, so a page can be renumbered rarely. */
export const FAQ_ORDER_STEP = 10;
/** Safety cap on the FAQ table (staff write them one by one). */
export const FAQ_LOAD_LIMIT = 2000;

/** The pages FAQs can live on (fixed pages, then every product by rank). */
export async function loadFaqPages(client: Db = db): Promise<FaqPageOption[]> {
  const products = await client.product.findMany({ select: { id: true, shortName: true }, orderBy: [{ rank: "asc" }, { id: "asc" }] });
  return faqPageOptions(products.map((p) => ({ id: p.id, name: p.shortName })));
}

function byPagePosition(a: Pick<Faq, "sortOrder" | "id">, b: Pick<Faq, "sortOrder" | "id">): number {
  return a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
}

/** DTOs with each FAQ's place on its page. */
export function toFaqDtos(rows: readonly Faq[], pages: readonly FaqPageOption[]): FaqDto[] {
  const byPage = new Map<string, Faq[]>();
  for (const f of rows) byPage.set(f.page, [...(byPage.get(f.page) ?? []), f]);
  const position = new Map<string, { position: number; count: number }>();
  for (const list of byPage.values()) {
    list.sort(byPagePosition).forEach((f, i) => position.set(f.id, { position: i + 1, count: list.length }));
  }
  return rows.map((f) => ({
    id: f.id,
    page: f.page,
    pageLabel: faqPageLabel(f.page, pages),
    question: f.question,
    answer: f.answer,
    href: f.href,
    published: f.published,
    status: f.published ? "published" : "draft",
    sortOrder: f.sortOrder,
    position: position.get(f.id)?.position ?? 1,
    pageCount: position.get(f.id)?.count ?? 1,
  }));
}

/** Every FAQ and the page options. */
export async function loadFaqs(client: Db = db): Promise<{ faqs: FaqDto[]; pages: FaqPageOption[] }> {
  const [rows, pages] = await Promise.all([
    client.faq.findMany({ orderBy: [{ page: "asc" }, { sortOrder: "asc" }, { id: "asc" }], take: FAQ_LOAD_LIMIT }),
    loadFaqPages(client),
  ]);
  return { faqs: toFaqDtos(rows, pages), pages };
}

/** GET /api/admin/faqs */
export async function listFaqs(query: FaqListQuery & { page: number; pageSize: number }, client: Db = db): Promise<ListPage<FaqDto>> {
  const { faqs, pages } = await loadFaqs(client);
  const rows = filterAndSortFaqs(faqs, query, pages);
  const start = (query.page - 1) * query.pageSize;
  return pageResult(rows.slice(start, start + query.pageSize), rows.length, query);
}

/** Audit target for a FAQ: its question, cut to 80 characters. */
export function faqTarget(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}\u2026` : flat;
}

async function assertPage(client: Db, page: string): Promise<FaqPageOption[]> {
  const pages = await loadFaqPages(client);
  if (!pages.some((p) => p.value === page)) throw errors.validation({ page: FAQ_ERRORS.page });
  return pages;
}

async function nextSortOrder(tx: Tx, page: string): Promise<number> {
  const last = await tx.faq.aggregate({ where: { page }, _max: { sortOrder: true } });
  return (last._max.sortOrder ?? 0) + FAQ_ORDER_STEP;
}

async function lockFaq(tx: Tx, id: string): Promise<Faq> {
  await tx.$queryRaw`SELECT "id" FROM "Faq" WHERE "id" = ${id} FOR UPDATE`;
  const faq = await tx.faq.findUnique({ where: { id } });
  if (!faq) throw errors.notFound("FAQ");
  return faq;
}

async function dtoOf(tx: Db, faq: Faq, pages: readonly FaqPageOption[]): Promise<FaqDto> {
  const siblings = await tx.faq.findMany({ where: { page: faq.page }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
  return toFaqDtos(siblings, pages).find((f) => f.id === faq.id) ?? toFaqDtos([faq], pages)[0]!;
}

/** POST /api/admin/faqs: at the end of its page; a draft unless published. Audited "Created FAQ". */
export async function createFaq(input: FaqCreateInput, ctx: ContentActorContext, client: typeof db = db): Promise<FaqDto> {
  const pages = await assertPage(client, input.page);
  const dto = await client.$transaction(async (tx) => {
    const created = await tx.faq.create({
      data: {
        page: input.page,
        question: input.question,
        answer: input.answer,
        href: input.href,
        published: input.published,
        sortOrder: await nextSortOrder(tx, input.page),
      },
    });
    await audit(tx, ctx.actor, {
      action: "Created FAQ",
      target: faqTarget(created.question),
      targetType: "faq",
      targetId: created.id,
      detail: `${faqPageLabel(created.page, pages)} page \u00b7 ${created.published ? "published" : "draft"}`,
    });
    return dtoOf(tx, created, pages);
  });
  if (dto.published) revalidateStorefront("faqs");
  return dto;
}

export type FaqWriteResult = { faq: FaqDto; changed: boolean };

/**
 * PATCH /api/admin/faqs/:id. A publish toggle alone is audited "Published FAQ" / "Unpublished FAQ"; anything else
 * "Edited FAQ" with the changed fields. Moving to another page puts it at the end of that page.
 */
export async function updateFaq(id: string, patch: FaqUpdateInput, ctx: ContentActorContext, client: typeof db = db): Promise<FaqWriteResult> {
  if (Object.values(patch).every((v) => v === undefined)) throw errors.validation({}, [FAQ_ERRORS.nothingToSave]);
  const pages = patch.page !== undefined ? await assertPage(client, patch.page) : await loadFaqPages(client);
  const result = await client.$transaction(async (tx) => {
    const current = await lockFaq(tx, id);
    const next = {
      page: patch.page ?? current.page,
      question: patch.question ?? current.question,
      answer: patch.answer ?? current.answer,
      href: patch.href === undefined ? current.href : patch.href,
      published: patch.published ?? current.published,
    };
    const fields: string[] = [];
    if (next.page !== current.page) fields.push(`page ${faqPageLabel(current.page, pages)} \u2192 ${faqPageLabel(next.page, pages)}`);
    if (next.question !== current.question) fields.push("question");
    if (next.answer !== current.answer) fields.push("answer");
    if (next.href !== current.href) fields.push(next.href ? `link ${next.href}` : "link removed");
    const publishChanged = next.published !== current.published;
    if (fields.length === 0 && !publishChanged) return { faq: await dtoOf(tx, current, pages), changed: false, wasPublished: current.published };

    const updated = await tx.faq.update({
      where: { id },
      data: { ...next, ...(next.page !== current.page ? { sortOrder: await nextSortOrder(tx, next.page) } : {}) },
    });
    const action = fields.length === 0 ? (next.published ? "Published FAQ" : "Unpublished FAQ") : "Edited FAQ";
    if (fields.length > 0 && publishChanged) fields.push(next.published ? "published" : "unpublished");
    await audit(tx, ctx.actor, {
      action,
      target: faqTarget(updated.question),
      targetType: "faq",
      targetId: id,
      detail: fields.length > 0 ? fields.join(" \u00b7 ") : `${faqPageLabel(updated.page, pages)} page`,
    });
    return { faq: await dtoOf(tx, updated, pages), changed: true, wasPublished: current.published };
  });
  if (result.changed && (result.wasPublished || result.faq.published)) revalidateStorefront("faqs");
  return { faq: result.faq, changed: result.changed };
}

/** POST /api/admin/faqs/:id/move: swaps places with its neighbour on the page (renumbers the page in steps of 10). */
export async function moveFaq(id: string, input: FaqMoveInput, ctx: ContentActorContext, client: typeof db = db): Promise<FaqWriteResult> {
  const pages = await loadFaqPages(client);
  const result = await client.$transaction(async (tx) => {
    const current = await lockFaq(tx, id);
    await tx.$queryRaw`SELECT "id" FROM "Faq" WHERE "page" = ${current.page} FOR UPDATE`;
    const siblings = (await tx.faq.findMany({ where: { page: current.page } })).sort(byPagePosition);
    const from = siblings.findIndex((f) => f.id === id);
    const to = input.direction === "up" ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= siblings.length) return { faq: await dtoOf(tx, current, pages), changed: false, published: current.published };
    const order = [...siblings];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved!);
    for (const [i, f] of order.entries()) {
      const sortOrder = (i + 1) * FAQ_ORDER_STEP;
      if (f.sortOrder !== sortOrder) await tx.faq.update({ where: { id: f.id }, data: { sortOrder } });
    }
    await audit(tx, ctx.actor, {
      action: "Reordered FAQ",
      target: faqTarget(current.question),
      targetType: "faq",
      targetId: id,
      detail: `${faqPageLabel(current.page, pages)} page \u00b7 position ${from + 1} \u2192 ${to + 1}`,
    });
    const updated = await tx.faq.findUniqueOrThrow({ where: { id } });
    return { faq: await dtoOf(tx, updated, pages), changed: true, published: current.published };
  });
  if (result.changed && result.published) revalidateStorefront("faqs");
  return { faq: result.faq, changed: result.changed };
}

/** POST /api/admin/faqs/bulk: publishes or unpublishes the given FAQs; one audit row per FAQ that changed. */
export async function bulkSetFaqsPublished(input: FaqBulkInput, ctx: ContentActorContext, client: typeof db = db): Promise<{ updated: number }> {
  const ids = [...new Set(input.ids)];
  const updated = await client.$transaction(async (tx) => {
    const rows = await tx.faq.findMany({ where: { id: { in: ids }, published: !input.published } });
    if (rows.length === 0) return 0;
    await tx.faq.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { published: input.published } });
    for (const f of rows) {
      await audit(tx, ctx.actor, {
        action: input.published ? "Published FAQ" : "Unpublished FAQ",
        target: faqTarget(f.question),
        targetType: "faq",
        targetId: f.id,
        detail: "Bulk action",
      });
    }
    return rows.length;
  });
  if (updated > 0) revalidateStorefront("faqs");
  return { updated };
}

/** DELETE /api/admin/faqs/:id (DESTRUCTIVE_ACTIONS "faqs.delete": reason, one audit row "Deleted FAQ"). */
export async function deleteFaq(id: string, input: DestructiveInput, ctx: ContentStaffContext, client: typeof db = db): Promise<{ id: string }> {
  const [pages, existing] = await Promise.all([loadFaqPages(client), client.faq.findUnique({ where: { id }, select: { question: true } })]);
  const deleted = await runDestructive(
    "faqs.delete",
    {
      staff: ctx.staff,
      actor: ctx.actor,
      input,
      targetId: id,
      target: existing ? faqTarget(existing.question) : id,
      targetType: "faq",
      client,
      detail: (r: { detail: string }) => r.detail,
    },
    async (tx) => {
      const faq = await lockFaq(tx, id);
      await tx.faq.delete({ where: { id } });
      return { published: faq.published, detail: `${faqPageLabel(faq.page, pages)} page · ${faq.published ? "was published" : "draft"}` };
    },
  );
  if (deleted.published) revalidateStorefront("faqs");
  return { id };
}

/** faqs.csv columns. */
export const FAQ_CSV_COLUMNS = [
  { header: "Page", value: (f: FaqDto) => f.pageLabel },
  { header: "Position", value: (f: FaqDto) => f.position },
  { header: "Question", value: (f: FaqDto) => f.question },
  { header: "Answer", value: (f: FaqDto) => f.answer },
  { header: "Link", value: (f: FaqDto) => f.href ?? "" },
  { header: "Status", value: (f: FaqDto) => (f.published ? "Published" : "Draft") },
] as const;

// ---------- Site banner and sample notice ----------

const NOTICE_SETTING = { banner: "content.banner", "sample-notice": "content.sampleNotice" } as const;

const NOTICE_AUDIT: Readonly<Record<ContentNoticeKey, { on: string; off: string; edited: string; target: string }>> = {
  banner: { on: "Enabled site banner", off: "Disabled site banner", edited: "Edited site banner", target: "Site banner" },
  "sample-notice": { on: "Enabled sample notice", off: "Disabled sample notice", edited: "Edited sample notice", target: "Sample notice" },
};

/** The banner and the sample notice as stored (defaults filled in). */
export async function getContentNotices(client: Db = db): Promise<Record<ContentNoticeKey, ContentNoticeDto>> {
  const rows = await client.siteSetting.findMany({ where: { key: { in: Object.values(NOTICE_SETTING) } } });
  const out = {} as Record<ContentNoticeKey, ContentNoticeDto>;
  for (const key of CONTENT_NOTICE_KEYS) {
    const settingKey = NOTICE_SETTING[key];
    const row = rows.find((r) => r.key === settingKey);
    const value = parseStoredSetting(settingKey, row?.value);
    out[key] = { enabled: value.enabled, text: value.text, updatedAt: row?.updatedAt.toISOString() ?? null };
  }
  return out;
}

/**
 * PATCH /api/admin/content/banner | sample-notice: merges { enabled?, text? } into the stored value, validates it with
 * the settings schema (an enabled banner needs text) and audits "Enabled/Disabled site banner" or "Edited site
 * banner" (sample notice alike). A patch that changes nothing writes nothing.
 */
export async function updateContentNotice(
  key: ContentNoticeKey,
  patch: NoticePatchInput,
  ctx: ContentActorContext,
  client: typeof db = db,
): Promise<{ notice: ContentNoticeDto; changed: boolean }> {
  if (patch.enabled === undefined && patch.text === undefined) throw errors.validation({}, [FAQ_ERRORS.nothingToSave]);
  const settingKey = NOTICE_SETTING[key];
  const result = await client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "key" FROM "SiteSetting" WHERE "key" = ${settingKey} FOR UPDATE`;
    const row = await tx.siteSetting.findUnique({ where: { key: settingKey } });
    const current = parseStoredSetting(settingKey, row?.value);
    const merged = { enabled: patch.enabled ?? current.enabled, text: patch.text ?? current.text };
    const parsed = settingSchemas[settingKey].safeParse(merged);
    if (!parsed.success) {
      const textIssue = parsed.error.issues.some((i) => i.path[0] === "text");
      throw errors.validation(textIssue ? { text: key === "banner" ? FAQ_ERRORS.bannerText : FAQ_ERRORS.noticeText } : {}, textIssue ? [] : [FAQ_ERRORS.nothingToSave]);
    }
    const next = parsed.data;
    const enabledChanged = next.enabled !== current.enabled;
    const textChanged = next.text !== current.text;
    if (!enabledChanged && !textChanged && row) {
      return { notice: { enabled: current.enabled, text: current.text, updatedAt: row.updatedAt.toISOString() }, changed: false };
    }
    const saved = await tx.siteSetting.upsert({
      where: { key: settingKey },
      create: { key: settingKey, value: next },
      update: { value: next },
    });
    const labels = NOTICE_AUDIT[key];
    await audit(tx, ctx.actor, {
      action: enabledChanged ? (next.enabled ? labels.on : labels.off) : labels.edited,
      target: labels.target,
      targetType: "settings",
      targetId: settingKey,
      detail: next.text || null,
    });
    return { notice: { enabled: next.enabled, text: next.text, updatedAt: saved.updatedAt.toISOString() }, changed: true };
  });
  if (result.changed) revalidateStorefront("settings");
  return result;
}
