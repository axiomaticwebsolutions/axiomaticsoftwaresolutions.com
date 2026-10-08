/**
 * Which payment attempts the ACTIVE payment keys can still reach (reconcile and refunds; docs/decisions.md 2026-10-08).
 * Payment.providerKeyId records the key id each attempt was created with (null before 2026-10-08).
 *
 * - The same key id, or a null one (attempts made before key ids were recorded): reachable.
 * - Another Razorpay key id of the SAME mode (rzp_test_ / rzp_live_): reachable. Regenerating keys in the Razorpay
 *   Dashboard gives a new Key ID for the same account, and the new keys see every order and payment of that account.
 *   A key of another account in the same mode cannot be told apart by its id: Razorpay then answers "not found",
 *   which reconcile counts as an error and a refund turns into 409 provider_key_changed.
 * - A test key against live keys (or the reverse), the mock's keys, or another provider: not reachable.
 * Pure (no database, no server-only), so it is unit-tested directly.
 */
import { razorpayMode } from "@/lib/integrations/model";

/** Whether the active keys (`activeKeyId`) can reach a payment created with `paymentKeyId` (see the module comment). */
export function keysCanReach(paymentKeyId: string | null, activeKeyId: string): boolean {
  if (paymentKeyId === null || paymentKeyId === activeKeyId) return true;
  const mode = razorpayMode(activeKeyId);
  return mode !== null && razorpayMode(paymentKeyId) === mode;
}

/** The same rule as a Prisma `Payment` filter: null, the active key id, or any Razorpay key id of the active mode. */
export function reachablePaymentKeys(activeKeyId: string): {
  OR: ({ providerKeyId: null } | { providerKeyId: string } | { providerKeyId: { startsWith: string } })[];
} {
  const mode = razorpayMode(activeKeyId);
  return {
    OR: [{ providerKeyId: null }, { providerKeyId: activeKeyId }, ...(mode ? [{ providerKeyId: { startsWith: `rzp_${mode}_` } }] : [])],
  };
}
