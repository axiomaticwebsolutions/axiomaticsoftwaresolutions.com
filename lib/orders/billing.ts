/**
 * The billing snapshot stored on Order.billing at checkout (name, email, phone, business, address, city, state, pin,
 * gstin). It is what the tax invoice prints. Staff may change it on an unpaid order (Admin > Orders edit); on a paid
 * order it changes only through an audited billing correction, which keeps the original in InvoiceCorrection
 * (lib/admin/orders/correction.ts).
 */
import type { Billing } from "@/lib/validation/billing";

export type BillingSnapshot = {
  name: string;
  email: string;
  phone: string;
  business: string | null;
  address: string;
  city: string;
  state: string;
  pin: string;
  gstin: string | null;
};

/** The snapshot for validated checkout billing details (billingSchema output). */
export function billingSnapshot(billing: Billing): BillingSnapshot {
  return {
    name: billing.name,
    email: billing.email,
    phone: billing.phone,
    business: billing.business ?? null,
    address: billing.address,
    city: billing.city,
    state: billing.state,
    pin: billing.pin,
    gstin: billing.gstin ?? null,
  };
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const optionalText = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Reads a stored snapshot leniently (older rows or seeds may miss fields); never throws. */
export function readBillingSnapshot(json: unknown): BillingSnapshot {
  const v = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  return {
    name: text(v.name),
    email: text(v.email),
    phone: text(v.phone),
    business: optionalText(v.business),
    address: text(v.address),
    city: text(v.city),
    state: text(v.state),
    pin: text(v.pin),
    gstin: optionalText(v.gstin),
  };
}
