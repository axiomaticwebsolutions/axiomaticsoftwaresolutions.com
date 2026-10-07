/**
 * Server validation errors for admin forms (Coupons, FAQs, Templates, Leads): the first message per field and the
 * form-level messages of a 422 `validation_failed`, or the error's own message for other refusals. Pure.
 */
import { ApiClientError, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";

export type FormErrors = { fields: Record<string, string>; form: string | null };

export const NO_ERRORS: FormErrors = { fields: {}, form: null };

export function formErrorsFrom(error: unknown): FormErrors {
  if (!(error instanceof ApiClientError)) return { fields: {}, form: UNEXPECTED_ERROR_MESSAGE };
  const fields: Record<string, string> = {};
  for (const [key, messages] of Object.entries(error.fieldErrors)) {
    if (messages[0]) fields[key] = messages[0];
  }
  const raw = error.details.formErrors;
  const formMessages = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
  const form = formMessages[0] ?? (Object.keys(fields).length === 0 ? error.message : null);
  return { fields, form };
}
