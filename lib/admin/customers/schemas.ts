/**
 * Strict request bodies of the admin customer routes. Pure (destructive bodies carry `reason`, validated by
 * lib/admin/destructive.ts so a missing reason answers 422 `reason_required`; form bodies call requireReason()).
 * The field schemas are the portal's and registration's (lib/validation/portal.ts, lib/validation/contact.ts), so a
 * customer created or edited by staff is normalised exactly like one who registered or edited their own details.
 */
import { z } from "zod";
import { destructiveFields } from "@/lib/admin/destructive";
import { ADMIN_ID_RE } from "@/lib/admin/licenses/schemas";
import { BUSINESS_NAME_MAX } from "@/lib/validation/auth";
import { BILLING_MAX } from "@/lib/validation/billing";
import { makeEmailSchema } from "@/lib/validation/contact";
import {
  billingDetailsIssue,
  gstinFieldSchema,
  legalNameSchema,
  optionalLine,
  personNameSchema,
  phoneFieldSchema,
  pinFieldSchema,
  PORTAL_ERRORS,
  stateFieldSchema,
} from "@/lib/validation/portal";
import { CUSTOMER_FORM_ERRORS } from "./model";

const userIdField = z.string().regex(ADMIN_ID_RE, "Choose a member of this account.").optional();

/** Resend verification / send password reset: the account's first active Owner, or `userId` (a member). */
export const customerEmailActionBody = z.strictObject({ userId: userIdField });

/** Mark email as verified / create a set-password link: `{ reason, userId? }` (reason checked first). */
export const customerDestructiveBody = z.strictObject({ ...destructiveFields, userId: userIdField });

/** Reasons are checked by requireReason() (422 reason_required / reason_too_long), not here. */
const reasonField = z.string().max(2000).nullish();

const optionalBusinessFields = {
  gstin: gstinFieldSchema.optional(),
  address: optionalLine(BILLING_MAX.address, PORTAL_ERRORS.addressTooLong).optional(),
  city: optionalLine(BILLING_MAX.city, PORTAL_ERRORS.cityTooLong).optional(),
  state: stateFieldSchema.optional(),
  pin: pinFieldSchema.optional(),
};

/**
 * POST /api/admin/customers: the person (name, email trimmed and lower-cased like registration, optional Indian
 * mobile) and the business details the data model has (an empty legal name becomes the person's name). A GSTIN needs
 * the state it is registered in (billingDetailsIssue, on gstin or state).
 */
export const customerCreateBody = z
  .strictObject({
    name: personNameSchema,
    email: makeEmailSchema(CUSTOMER_FORM_ERRORS.email),
    phone: phoneFieldSchema.optional(),
    legalName: optionalLine(BUSINESS_NAME_MAX, PORTAL_ERRORS.legalNameTooLong).optional(),
    ...optionalBusinessFields,
    emailVerified: z.boolean({ error: "Choose yes or no." }).optional(),
    reason: reasonField,
  })
  .superRefine((value, ctx) => {
    const issue = billingDetailsIssue({ gstin: value.gstin ?? null, state: value.state ?? null });
    if (issue) ctx.addIssue({ code: "custom", path: [issue.field], message: issue.message });
  });
export type CustomerCreateInput = z.output<typeof customerCreateBody>;

/**
 * PATCH /api/admin/customers/:id: any subset of the owner's name, mobile and email and the account's business details
 * (omitted keys stay; "" or null clears an optional one). `emailVerified: true` only together with an email. The
 * GSTIN/state rule runs on the merged details in the service, because either may be omitted.
 */
export const customerPatchBody = z
  .strictObject({
    name: personNameSchema.optional(),
    email: makeEmailSchema(CUSTOMER_FORM_ERRORS.email).optional(),
    phone: phoneFieldSchema.optional(),
    legalName: legalNameSchema.optional(),
    ...optionalBusinessFields,
    emailVerified: z.boolean({ error: "Choose yes or no." }).optional(),
    reason: reasonField,
  })
  .superRefine((value, ctx) => {
    const { reason: _reason, emailVerified, ...fields } = value;
    if (Object.values(fields).every((v) => v === undefined)) {
      ctx.addIssue({ code: "custom", path: [], message: CUSTOMER_FORM_ERRORS.nothingToUpdate });
    } else if (emailVerified === true && value.email === undefined) {
      ctx.addIssue({ code: "custom", path: ["emailVerified"], message: CUSTOMER_FORM_ERRORS.emailVerifiedWithoutChange });
    }
  });
export type CustomerPatchInput = z.output<typeof customerPatchBody>;
