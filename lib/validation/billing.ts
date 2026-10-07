import { z } from "zod";

import { makeEmailSchema, makeIndianMobileSchema, makePinSchema } from "@/lib/validation/contact";
import { isValidGstin, gstinStateName, normalizeGstin } from "@/lib/validation/gstin";
import { isLinkLikeName, NAME_LINK_ERROR } from "@/lib/validation/names";
import { INDIAN_STATES, isIndianState } from "@/lib/validation/states";

/** Field errors, copied from Checkout.dc.html (GSTIN copy from the prototype's server-side createOrder). */
export const BILLING_ERRORS = {
  name: "Enter your full name.",
  nameLink: NAME_LINK_ERROR,
  email: "Enter a valid email address, like name@business.com.",
  phone: "Enter a 10-digit mobile number.",
  address: "Enter your billing address.",
  city: "Enter your city.",
  pin: "PIN code should be 6 digits.",
  state: "Select your state or union territory.",
  gstin: "GSTIN should be 15 characters, like 27ABCDE1234F1Z5.",
} as const;

/** Input length limits (characters, after whitespace clean-up). */
export const BILLING_MAX = {
  name: 100,
  business: 120,
  address: 300,
  city: 80,
  /** Raw GSTIN input before spaces are stripped. */
  gstinInput: 20,
} as const;

export function tooLongMessage(max: number): string {
  return `Use ${max} characters or fewer.`;
}

/** New copy (no prototype equivalent): the GSTIN prefix and the selected billing state disagree. */
export function gstinStateMismatchMessage(state: string): string {
  return `This GSTIN is registered in ${state}. Choose ${state} as the billing state or check the GSTIN.`;
}

/**
 * Collapses whitespace and control characters (newlines, tabs, NUL, C1 controls) into single spaces
 * and trims. Billing fields are single-line inputs and end up on invoices and in emails.
 */
export function cleanLine(value: string): string {
  return value.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

function requiredText(message: string, max: number) {
  return z
    .string({ error: message })
    .overwrite(cleanLine)
    .superRefine((value, ctx) => {
      if (value.length === 0) ctx.addIssue(message);
      else if (value.length > max) ctx.addIssue(tooLongMessage(max));
    });
}

const businessSchema = z
  .string({ error: tooLongMessage(BILLING_MAX.business) })
  .overwrite(cleanLine)
  .max(BILLING_MAX.business, { message: tooLongMessage(BILLING_MAX.business) })
  .nullish()
  .transform((value) => (value ? value : undefined));

const gstinSchema = z
  .string({ error: BILLING_ERRORS.gstin })
  .max(BILLING_MAX.gstinInput, { message: BILLING_ERRORS.gstin })
  .nullish()
  .transform((value) => {
    const normalized = value == null ? "" : normalizeGstin(value);
    return normalized === "" ? undefined : normalized;
  })
  .refine((value) => value === undefined || isValidGstin(value), { message: BILLING_ERRORS.gstin });

/**
 * Checkout billing details. Output: trimmed text, lower-case email, ten-digit mobile, a state from
 * INDIAN_STATES, and an upper-case GSTIN (or undefined) whose state code matches the billing state.
 */
export const billingSchema = z
  .object({
    name: requiredText(BILLING_ERRORS.name, BILLING_MAX.name).refine((value) => !isLinkLikeName(value), {
      message: BILLING_ERRORS.nameLink,
    }),
    email: makeEmailSchema(BILLING_ERRORS.email),
    phone: makeIndianMobileSchema(BILLING_ERRORS.phone),
    business: businessSchema,
    address: requiredText(BILLING_ERRORS.address, BILLING_MAX.address),
    city: requiredText(BILLING_ERRORS.city, BILLING_MAX.city),
    state: z.enum(INDIAN_STATES, { error: BILLING_ERRORS.state }),
    pin: makePinSchema(BILLING_ERRORS.pin),
    gstin: gstinSchema,
  })
  .strict()
  .superRefine(
    (billing, ctx) => {
      const { gstin, state } = billing;
      if (typeof gstin !== "string" || !isIndianState(state) || !isValidGstin(gstin)) return;
      const registered = gstinStateName(gstin);
      // "Other Territory" GSTINs cannot pick a matching billing state, so they are not cross-checked.
      if (registered === null || !isIndianState(registered) || registered === state) return;
      ctx.addIssue({ code: "custom", path: ["gstin"], message: gstinStateMismatchMessage(registered) });
    },
    // Run even when other fields failed, so the mismatch shows in the same round of errors.
    { when: (payload) => typeof payload.value === "object" && payload.value !== null },
  );

export type BillingInput = z.input<typeof billingSchema>;
export type Billing = z.output<typeof billingSchema>;
