/**
 * Who is at the checkout, and what to prefill (server-only; used by app/(checkout)/checkout/page.tsx).
 * Resolved exactly like the order API resolves the buyer (lib/checkout/buyer.ts): the signed-in user and their active
 * business account. Members whose team role cannot buy, and staff, see why up front (the API refuses them anyway) and
 * get no account billing prefill.
 */
import "server-only";
import { getCurrentAuth } from "@/lib/auth/guards";
import { PURCHASE_FORBIDDEN_MESSAGE, resolveCheckoutBuyer, STAFF_CHECKOUT_MESSAGE } from "@/lib/checkout/buyer";
import { db } from "@/lib/db";
import { teamCan } from "@/lib/rbac";
import { isIndianState } from "@/lib/validation/states";
import type { CheckoutValues } from "./checkout-form";

export type CheckoutViewer = {
  name: string;
  email: string;
  /** Why this viewer cannot place an order (staff session, team role without `purchases`), else null. */
  blockedMessage: string | null;
};

export type CheckoutPrefill = Partial<Pick<
  CheckoutValues,
  "name" | "email" | "phone" | "business" | "address" | "city" | "pin" | "state" | "gstin" | "hasGstin"
>>;

export async function loadCheckoutViewer(): Promise<{ viewer: CheckoutViewer | null; prefill: CheckoutPrefill }> {
  const auth = await getCurrentAuth();
  if (!auth) return { viewer: null, prefill: {} };
  const { user } = auth;
  const contact: CheckoutPrefill = { name: user.name, email: user.email, phone: user.phone ?? "" };
  const buyer = await resolveCheckoutBuyer(db, auth);
  if (buyer.kind === "staff") {
    return { viewer: { name: user.name, email: user.email, blockedMessage: STAFF_CHECKOUT_MESSAGE }, prefill: contact };
  }
  const membership = buyer.kind === "customer" ? buyer.membership : null;
  if (membership && !teamCan(membership.role, "purchases")) {
    return { viewer: { name: user.name, email: user.email, blockedMessage: PURCHASE_FORBIDDEN_MESSAGE }, prefill: contact };
  }
  const account = membership?.account ?? null;
  const prefill: CheckoutPrefill = account
    ? {
        ...contact,
        // legalName defaults to the person's name when no business name was given (register, checkout).
        business: account.legalName !== user.name ? account.legalName : "",
        address: account.address ?? "",
        city: account.city ?? "",
        pin: account.pin ?? "",
        state: account.state && isIndianState(account.state) ? account.state : "",
        gstin: account.gstin ?? "",
        hasGstin: Boolean(account.gstin),
      }
    : contact;
  return { viewer: { name: user.name, email: user.email, blockedMessage: null }, prefill };
}
