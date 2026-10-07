/**
 * Admin Content & FAQs (decisions.md Phase 6): FAQs per page with order, publish and an optional guide link; the site
 * banner and sample notice; every write audited and followed by revalidateTag (faqs / settings).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { faqCreateSchema, faqUpdateSchema } from "@/lib/admin/content/schemas";
import {
  bulkSetFaqsPublished,
  createFaq,
  deleteFaq,
  loadFaqs,
  moveFaq,
  updateFaq,
} from "@/lib/admin/content/service";
import { db } from "@/lib/db";
import { auditRows, makeProduct, rejection, staffFixture, tag, type StaffFixture } from "./admin-coupons-fixtures";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), revalidateTag }));

let admin: StaffFixture;
let support: StaffFixture;
let product: { id: string; name: string };

beforeAll(async () => {
  [admin, support, product] = await Promise.all([staffFixture("ADMIN"), staffFixture("SUPPORT"), makeProduct()]);
});
beforeEach(() => revalidateTag.mockClear());

const faq = (page: string, overrides: Record<string, unknown> = {}) =>
  faqCreateSchema.parse({ page, question: `Question ${tag()}?`, answer: "An answer long enough.", ...overrides });

describe("FAQs", () => {
  it("adds drafts at the end of their page, published ones revalidate the storefront", async () => {
    const a = await createFaq(faq(product.id), { actor: admin.actor });
    const b = await createFaq(faq(product.id, { published: true, href: "/docs/activation" }), { actor: admin.actor });
    expect(a).toMatchObject({ status: "draft", position: 1, pageLabel: product.name });
    expect(b).toMatchObject({ status: "published", position: 2, pageCount: 2, href: "/docs/activation" });
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
    expect(revalidateTag).toHaveBeenCalledTimes(1);
    expect(revalidateTag).toHaveBeenCalledWith("faqs");
    expect((await auditRows("faq", a.id))[0]).toMatchObject({ action: "Created FAQ", detail: `${product.name} page \u00b7 draft` });
  });

  it("refuses unknown pages, off-site links and unknown keys", async () => {
    expect(await rejection(createFaq(faq("no-such-page"), { actor: admin.actor }))).toMatchObject({ status: 422 });
    expect(faqCreateSchema.safeParse({ page: "home", question: "Valid question?", answer: "Valid answer.", href: "https://evil.example" }).success).toBe(false);
    expect(faqCreateSchema.safeParse({ page: "home", question: "Valid question?", answer: "Valid answer.", href: "//evil.example" }).success).toBe(false);
    expect(faqUpdateSchema.safeParse({ sortOrder: 3 }).success).toBe(false);
  });

  it("audits a publish toggle as Published FAQ and an edit as Edited FAQ with the fields", async () => {
    const f = await createFaq(faq(product.id), { actor: admin.actor });
    const pub = await updateFaq(f.id, { published: true }, { actor: admin.actor });
    expect(pub).toMatchObject({ changed: true, faq: { status: "published" } });
    const edit = await updateFaq(f.id, { answer: "A better answer here.", href: null }, { actor: admin.actor });
    expect(edit.changed).toBe(true);
    const again = await updateFaq(f.id, { answer: "A better answer here." }, { actor: admin.actor });
    expect(again.changed).toBe(false);
    const rows = await auditRows("faq", f.id);
    expect(rows.map((r) => [r.action, r.detail])).toEqual([
      ["Created FAQ", `${product.name} page \u00b7 draft`],
      ["Published FAQ", `${product.name} page`],
      ["Edited FAQ", "answer"],
    ]);
    expect(revalidateTag).toHaveBeenCalledTimes(2);
  });

  it("moves FAQs within their page and to the end of another page", async () => {
    const page = (await makeProduct()).id;
    const [x, y, z] = [await createFaq(faq(page), { actor: admin.actor }), await createFaq(faq(page), { actor: admin.actor }), await createFaq(faq(page), { actor: admin.actor })];
    const moved = await moveFaq(z!.id, { direction: "up" }, { actor: admin.actor });
    expect(moved.faq.position).toBe(2);
    const order = (await loadFaqs()).faqs.filter((f) => f.page === page).sort((a, b) => a.position - b.position).map((f) => f.id);
    expect(order).toEqual([x!.id, z!.id, y!.id]);
    expect((await moveFaq(x!.id, { direction: "up" }, { actor: admin.actor })).changed).toBe(false);
    expect((await auditRows("faq", z!.id)).at(-1)).toMatchObject({ action: "Reordered FAQ" });

    const toHome = await updateFaq(x!.id, { page: "home" }, { actor: admin.actor });
    expect(toHome.faq.page).toBe("home");
    expect(toHome.faq.position).toBe(toHome.faq.pageCount);
  });

  it("bulk-unpublishes with one audit row per FAQ that changed", async () => {
    const page = (await makeProduct()).id;
    const a = await createFaq(faq(page, { published: true }), { actor: admin.actor });
    const b = await createFaq(faq(page), { actor: admin.actor });
    const res = await bulkSetFaqsPublished({ ids: [a.id, b.id], published: false }, { actor: admin.actor });
    expect(res.updated).toBe(1);
    expect((await auditRows("faq", a.id)).at(-1)).toMatchObject({ action: "Unpublished FAQ", detail: "Bulk action" });
    expect((await auditRows("faq", b.id)).map((r) => r.action)).toEqual(["Created FAQ"]);
  });

  it("deletes only with a reason (faqs.delete), for content.manage roles, with one audit row", async () => {
    const f = await createFaq(faq(product.id, { published: true }), { actor: admin.actor });
    expect(await rejection(deleteFaq(f.id, {}, { staff: admin.staff, actor: admin.actor }))).toMatchObject({ status: 422, code: "reason_required" });
    expect(await rejection(deleteFaq(f.id, { reason: "Outdated" }, { staff: support.staff, actor: support.actor }))).toMatchObject({ status: 403 });
    revalidateTag.mockClear();
    await deleteFaq(f.id, { reason: "Outdated answer" }, { staff: admin.staff, actor: admin.actor });
    expect(await db.faq.findUnique({ where: { id: f.id } })).toBeNull();
    const deleted = (await auditRows("faq", f.id)).filter((r) => r.action === "Deleted FAQ");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ reason: "Outdated answer", target: f.question });
    expect(revalidateTag).toHaveBeenCalledWith("faqs");
  });
});
