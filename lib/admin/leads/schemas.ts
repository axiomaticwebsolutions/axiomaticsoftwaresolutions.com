/** Request body of PATCH /api/admin/leads/:id (strict Zod; 422 validation_failed). Pure and client-safe. */
import { z } from "zod";
import { LEAD_ERRORS, LEAD_NOTE_MAX, LEAD_STATUS_VALUES } from "./model";

export const leadUpdateSchema = z.strictObject({
  status: z.enum(LEAD_STATUS_VALUES, { error: LEAD_ERRORS.status }).optional(),
  /** Saved as the audit row's reason; "" means no note. */
  note: z.string({ error: LEAD_ERRORS.note }).trim().max(LEAD_NOTE_MAX, LEAD_ERRORS.note).optional(),
});
export type LeadUpdateInput = z.output<typeof leadUpdateSchema>;
