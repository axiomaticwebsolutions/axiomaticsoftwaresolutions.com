/**
 * Request bodies of the FAQ and storefront notice admin APIs (strict Zod; 422 validation_failed with field errors).
 * Pure and client-safe.
 */
import { z } from "zod";
import { FAQ_ERRORS, NOTICE_TEXT_MAX } from "./model";

/** A path on this site ("/docs/activation", "/legal/refund#trials"); never another host or a protocol-relative URL. */
export const FAQ_HREF_RE = /^\/(?!\/)[A-Za-z0-9\-._~/#?=&%]*$/;
export const FAQ_HREF_MAX = 200;

const question = z.string({ error: FAQ_ERRORS.question }).trim().min(5, FAQ_ERRORS.question).max(300, FAQ_ERRORS.question);
const answer = z.string({ error: FAQ_ERRORS.answer }).trim().min(5, FAQ_ERRORS.answer).max(3000, FAQ_ERRORS.answer);
const page = z.string({ error: FAQ_ERRORS.page }).trim().min(1, FAQ_ERRORS.page).max(80, FAQ_ERRORS.page);
/** "" or null clears the link. */
const href = z
  .string({ error: FAQ_ERRORS.href })
  .trim()
  .max(FAQ_HREF_MAX, FAQ_ERRORS.href)
  .refine((v) => v === "" || FAQ_HREF_RE.test(v), FAQ_ERRORS.href)
  .nullable()
  .transform((v) => (v === null || v === "" ? null : v));

/** POST /api/admin/faqs: a draft unless `published` is true. */
export const faqCreateSchema = z.strictObject({
  page,
  question,
  answer,
  href: href.optional().transform((v) => v ?? null),
  published: z.boolean().optional().transform((v) => v ?? false),
});
export type FaqCreateInput = z.output<typeof faqCreateSchema>;

/** PATCH /api/admin/faqs/:id. Moving to another page puts the FAQ at the end of that page. */
export const faqUpdateSchema = z.strictObject({
  page: page.optional(),
  question: question.optional(),
  answer: answer.optional(),
  href: href.optional(),
  published: z.boolean().optional(),
});
export type FaqUpdateInput = z.output<typeof faqUpdateSchema>;

/** POST /api/admin/faqs/:id/move */
export const faqMoveSchema = z.strictObject({ direction: z.enum(["up", "down"], { error: FAQ_ERRORS.direction }) });
export type FaqMoveInput = z.output<typeof faqMoveSchema>;

/** POST /api/admin/faqs/bulk: publish or unpublish up to 100 FAQs. */
export const faqBulkSchema = z.strictObject({
  ids: z.array(z.string().trim().min(1).max(128), { error: FAQ_ERRORS.ids }).min(1, FAQ_ERRORS.ids).max(100, FAQ_ERRORS.ids),
  published: z.boolean(),
});
export type FaqBulkInput = z.output<typeof faqBulkSchema>;

/** PATCH /api/admin/content/banner and /api/admin/content/sample-notice. */
export const noticePatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  text: z.string({ error: FAQ_ERRORS.noticeText }).trim().max(NOTICE_TEXT_MAX, FAQ_ERRORS.noticeText).optional(),
});
export type NoticePatchInput = z.output<typeof noticePatchSchema>;
