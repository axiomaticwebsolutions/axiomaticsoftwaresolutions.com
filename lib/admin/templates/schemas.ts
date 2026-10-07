/** Request bodies of the template admin API (strict Zod; 422 validation_failed). Pure and client-safe. */
import { z } from "zod";
import { MAX_SUBJECT_LENGTH } from "@/lib/email/render";
import { TEMPLATE_BODY_MAX, TEMPLATE_ERRORS } from "./model";

const subject = z
  .string({ error: TEMPLATE_ERRORS.subject })
  .trim()
  .min(1, TEMPLATE_ERRORS.subject)
  .max(MAX_SUBJECT_LENGTH, TEMPLATE_ERRORS.subject)
  .refine((v) => !/[\r\n]/.test(v), TEMPLATE_ERRORS.subject);
const body = z
  .string({ error: TEMPLATE_ERRORS.body })
  .overwrite((v) => v.replace(/\r\n?/g, "\n"))
  .trim()
  .min(1, TEMPLATE_ERRORS.body)
  .max(TEMPLATE_BODY_MAX, TEMPLATE_ERRORS.body);

/** PATCH /api/admin/templates/:id: copy and/or the active switch (draft = the built-in copy is sent). */
export const templateUpdateSchema = z.strictObject({
  subject: subject.optional(),
  body: body.optional(),
  active: z.boolean().optional(),
});
export type TemplateUpdateInput = z.output<typeof templateUpdateSchema>;

/** POST /api/admin/templates/:id/test: optionally the unsaved copy from the editor. */
export const templateTestSchema = z.strictObject({
  subject: subject.optional(),
  body: body.optional(),
});
export type TemplateTestInput = z.output<typeof templateTestSchema>;
