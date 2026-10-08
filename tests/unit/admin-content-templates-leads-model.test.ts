import { describe, expect, it } from "vitest";
import { faqExcerpt, faqPageLabel, faqPageOptions, filterAndSortFaqs, type FaqDto } from "@/lib/admin/content/model";
import { FAQ_HREF_RE, faqCreateSchema } from "@/lib/admin/content/schemas";
import { leadStatusesFor, leadSubtitle } from "@/lib/admin/leads/model";
import { leadUpdateSchema } from "@/lib/admin/leads/schemas";
import {
  filterAndSortTemplates,
  previewTemplate,
  previewText,
  templateDto,
  templateOrder,
  unknownTemplateVars,
} from "@/lib/admin/templates/model";
import { relativeAgo } from "@/lib/admin/templates/relative";
import { templateUpdateSchema } from "@/lib/admin/templates/schemas";
import { EMAIL_TEMPLATE_IDS } from "@/lib/email/defaults";

const pages = faqPageOptions([{ id: "medical-billing", name: "Medical Store Billing" }]);

describe("FAQ model", () => {
  const faq = (id: string, page: string, position: number, question: string, status: "published" | "draft" = "published") =>
    ({ id, page, pageLabel: faqPageLabel(page, pages), position, question, answer: `${question} answer`, status }) as FaqDto;
  const rows = [faq("1", "medical-billing", 1, "Zed"), faq("2", "pricing", 2, "Beta", "draft"), faq("3", "home", 1, "Alpha"), faq("4", "pricing", 1, "Gamma")];

  it("orders by page (fixed pages, then products) and position, filters and searches", () => {
    const q = { q: "", filters: {}, sort: { id: "order" as const, desc: false } };
    expect(filterAndSortFaqs(rows, q, pages).map((f) => f.id)).toEqual(["3", "4", "2", "1"]);
    expect(filterAndSortFaqs(rows, { ...q, filters: { page: "pricing", status: "draft" } }, pages).map((f) => f.id)).toEqual(["2"]);
    expect(filterAndSortFaqs(rows, { ...q, q: "medical store" }, pages).map((f) => f.id)).toEqual(["1"]);
    expect(filterAndSortFaqs(rows, { ...q, sort: { id: "question", desc: true } }, pages).map((f) => f.question)).toEqual(["Zed", "Gamma", "Beta", "Alpha"]);
  });

  it("labels pages, cuts excerpts at 90 characters and only allows site links", () => {
    expect(faqPageLabel("home", pages)).toBe("Home");
    expect(faqPageLabel("medical-billing", pages)).toBe("Medical Store Billing");
    expect(faqExcerpt("x".repeat(95))).toBe(`${"x".repeat(90)}\u2026`);
    expect(FAQ_HREF_RE.test("/docs/activation#offline")).toBe(true);
    expect(FAQ_HREF_RE.test("//evil.example")).toBe(false);
    expect(FAQ_HREF_RE.test("javascript:alert(1)")).toBe(false);
    expect(faqCreateSchema.parse({ page: "home", question: "Valid question?", answer: "Valid answer.", href: "" }).href).toBeNull();
  });
});

describe("Templates model", () => {
  const ctx = { footer: { legalName: "Axiomatic", address: "", city: "", state: "Maharashtra", pin: "", supportEmail: "support@example.com" }, appUrl: "https://axiomatic.example" };

  it("lists the catalogue first and derives status from the row", () => {
    expect(templateOrder(["zz_custom", "order_confirmation"])).toEqual([...EMAIL_TEMPLATE_IDS, "zz_custom"]);
    expect(templateDto("order_confirmation", null).status).toBe("default");
    const row = { name: "Order confirmation", subject: "S", body: "B", active: false, updatedAt: new Date("2026-10-01T00:00:00Z") };
    expect(templateDto("order_confirmation", row)).toMatchObject({ status: "draft", subject: "S", trigger: "An order is paid" });
  });

  it("finds unknown placeholders and previews with sample data through the renderer", () => {
    const t = templateDto("order_confirmation", null);
    expect(unknownTemplateVars(t, "Order {{order_id}}", "Hi {{customer_name}} {{ secret }}")).toEqual(["secret"]);
    const rendered = previewTemplate("order_confirmation", { subject: "Order {{order_id}} confirmed", body: "Hi {{customer_name}},\n\nThanks." }, ctx);
    expect(rendered.subject).toBe("Order AX-10312 confirmed");
    expect(previewText(rendered)).toMatch(/^Subject: Order AX-10312 confirmed\n\nHi Priya Sharma,/);
    expect(rendered.html).toContain("View your order");
    expect(previewTemplate("order_confirmation", { subject: "{{nope}}", body: "x" }, ctx).subject).toBe("{{nope}}");
  });

  it("previews the uploaded logo like real emails (Admin > Settings > Branding)", () => {
    const content = { subject: "Order {{order_id}}", body: "Hi." };
    expect(previewTemplate("order_confirmation", content, ctx).html).not.toContain("/brand/");
    const logo = { alt: "Axiomatic", light: { src: "https://axiomatic.example/brand/logo-light.png?v=3f2a9c1b0d4e", width: 144, height: 36 }, dark: null };
    const html = previewTemplate("order_confirmation", content, { ...ctx, logo }).html;
    expect(html).toContain('<img src="https://axiomatic.example/brand/logo-light.png?v=3f2a9c1b0d4e" width="144" height="36"');
  });

  it("filters by status and validates bodies", () => {
    const rows = [templateDto("order_confirmation", null), templateDto("renewal_7", { name: "R7", subject: "s", body: "b", active: true, updatedAt: new Date() })];
    expect(filterAndSortTemplates(rows, { q: "", filters: { status: "active" }, sort: { id: "order", desc: false } }).map((t) => t.id)).toEqual(["renewal_7"]);
    expect(templateUpdateSchema.safeParse({ subject: "Line\nbreak" }).success).toBe(false);
    expect(templateUpdateSchema.parse({ body: "a\r\nb" }).body).toBe("a\nb");
    expect(templateUpdateSchema.safeParse({ name: "x" }).success).toBe(false);
  });

  it("formats relative times like the prototype", () => {
    const now = "2026-10-07T12:00:00Z";
    expect(relativeAgo("2026-10-07T11:59:40Z", now)).toBe("just now");
    expect(relativeAgo("2026-10-07T11:48:00Z", now)).toBe("12m ago");
    expect(relativeAgo("2026-10-07T07:00:00Z", now)).toBe("5h ago");
    expect(relativeAgo("2026-10-04T12:00:00Z", now)).toBe("3d ago");
    expect(relativeAgo("2026-09-01T12:00:00Z", now)).toBe("1 Sep 2026");
    expect(relativeAgo(null, now)).toBe("\u2014");
  });
});

describe("Leads model", () => {
  it("offers Scheduled for demo requests only and validates the update body", () => {
    expect(leadStatusesFor("DEMO")).toContain("scheduled");
    expect(leadStatusesFor("CONTACT")).not.toContain("scheduled");
    expect(leadSubtitle({ id: "DEMO-1001", businessName: "Gupta Medical" })).toBe("DEMO-1001 \u00b7 Gupta Medical");
    expect(leadUpdateSchema.parse({ status: "closed", note: "  " })).toEqual({ status: "closed", note: "" });
    expect(leadUpdateSchema.safeParse({ status: "CLOSED" }).success).toBe(false);
  });
});
