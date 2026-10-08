/**
 * Billing correction rules for a paid order (docs/admin-records-design.md B7.1; decisions.md "Admin records" D17).
 * Pure and unit-tested.
 *
 * Tax neutrality: the place of supply (billing state) and the order email are fixed, the order amounts are never
 * touched and the service requires the seller's state to be the one on the original invoice, so intra- or inter-state
 * supply and the CGST/SGST/IGST split cannot change. checkout's billingSchema refuses a GSTIN registered in another
 * state, which with the state fixed is the guard against a tax change. Adding or removing a GSTIN in the same state
 * changes only B2B/B2C reporting, not the tax amounts: that is allowed and is the usual reason for a correction.
 */
import { billingSnapshot, type BillingSnapshot } from "@/lib/orders/billing";
import { billingSchema } from "@/lib/validation/billing";
import { ORDER_RECORD_MESSAGES } from "./records-model";

/** Fields a correction may change, in audit order. State and email are locked. */
export const CORRECTABLE_BILLING_FIELDS = ["name", "phone", "business", "address", "city", "pin", "gstin"] as const;
export type CorrectableBillingField = (typeof CORRECTABLE_BILLING_FIELDS)[number];

export type BillingCorrectionPatch = Partial<Record<CorrectableBillingField | "state" | "email", string | null | undefined>>;

export type CorrectedBilling =
  | { ok: true; billing: BillingSnapshot; changedFields: CorrectableBillingField[] }
  | { ok: false; fieldErrors: Record<string, string> };

const GSTIN_MISMATCH_PREFIX = "This GSTIN is registered in";

/**
 * The corrected snapshot: the stored one with the patch applied (undefined keeps a field; null or "" clears the
 * optional business name and GSTIN), validated with checkout's billingSchema. Field errors are keyed "billing.<field>".
 */
export function correctedBilling(stored: BillingSnapshot, patch: BillingCorrectionPatch): CorrectedBilling {
  const fieldErrors: Record<string, string> = {};
  if (typeof patch.state === "string" && patch.state.trim() !== stored.state) fieldErrors["billing.state"] = ORDER_RECORD_MESSAGES.stateLocked;
  if (typeof patch.email === "string" && patch.email.trim().toLowerCase() !== stored.email.toLowerCase()) {
    fieldErrors["billing.email"] = ORDER_RECORD_MESSAGES.emailLocked;
  }
  const pick = (key: CorrectableBillingField, current: string | null): string | null => {
    const value = patch[key];
    return value === undefined ? current : value;
  };
  const candidate = {
    name: pick("name", stored.name),
    email: stored.email,
    phone: pick("phone", stored.phone),
    business: pick("business", stored.business),
    address: pick("address", stored.address),
    city: pick("city", stored.city),
    state: stored.state,
    pin: pick("pin", stored.pin),
    gstin: pick("gstin", stored.gstin),
  };
  const parsed = billingSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = `billing.${issue.path.map(String).join(".") || "_"}`;
      if (fieldErrors[key]) continue;
      fieldErrors[key] =
        issue.path[0] === "gstin" && issue.message.startsWith(GSTIN_MISMATCH_PREFIX)
          ? `${issue.message}${ORDER_RECORD_MESSAGES.gstinStateSuffix}`
          : issue.message;
    }
  }
  if (Object.keys(fieldErrors).length > 0 || !parsed.success) return { ok: false, fieldErrors };
  const billing = billingSnapshot(parsed.data);
  const changedFields = CORRECTABLE_BILLING_FIELDS.filter((key) => (billing[key] ?? "") !== (stored[key] ?? ""));
  return { ok: true, billing, changedFields };
}
