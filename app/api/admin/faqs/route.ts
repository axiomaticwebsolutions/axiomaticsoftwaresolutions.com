/**
 * GET  /api/admin/faqs  (content.manage)  ?q=&filter[page]=home|pricing|support|<product id>&filter[status]=published|draft
 *                                         &sort=(-)order|question|page&page=&pageSize= -> { items: FaqDto[], total, page, pageSize }
 * POST /api/admin/faqs  (content.manage)  { page, question, answer, href?, published? } -> 201 { faq } (end of its page)
 */
import { FAQ_LIST_SPEC } from "@/lib/admin/content/model";
import { faqCreateSchema } from "@/lib/admin/content/schemas";
import { createFaq, listFaqs } from "@/lib/admin/content/service";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { json } from "@/lib/http";

export const GET = adminRoute("content.manage", async ({ req }) => json(await listFaqs(parseListQuery(req, FAQ_LIST_SPEC))));

export const POST = adminRoute("content.manage", async ({ body, actor }) => {
  const input = await body(faqCreateSchema);
  return json({ faq: await createFaq(input, { actor }) }, { status: 201 });
});
