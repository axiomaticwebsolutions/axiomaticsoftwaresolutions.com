/**
 * The "Notify me when it launches" form of a COMING_SOON product page: values, field order and the POST /api/contact
 * body (kind "waitlist"). Pure and client-safe; tests/unit/waitlist.test.ts.
 */
import type { LeadRequestBody } from "@/lib/validation/lead";

export type WaitlistValues = { name: string; email: string; phone: string; businessName: string; website: string };

export type WaitlistFieldKey = "name" | "email" | "phone" | "businessName";

/** Page order (also the error summary order). */
export const WAITLIST_FIELD_ORDER: readonly WaitlistFieldKey[] = ["name", "email", "phone", "businessName"];

export const EMPTY_WAITLIST_VALUES: WaitlistValues = { name: "", email: "", phone: "", businessName: "", website: "" };

export function waitlistFieldId(key: WaitlistFieldKey): string {
  return `waitlist-${key}`;
}

/** Stored with the lead as its source, e.g. "product:payroll". */
export function waitlistSource(productId: string): string {
  return `product:${productId}`;
}

export function waitlistRequestBody(productId: string, values: WaitlistValues): LeadRequestBody {
  return {
    kind: "waitlist",
    name: values.name,
    email: values.email,
    phone: values.phone,
    businessName: values.businessName,
    product: productId,
    website: values.website,
    source: waitlistSource(productId),
  };
}
