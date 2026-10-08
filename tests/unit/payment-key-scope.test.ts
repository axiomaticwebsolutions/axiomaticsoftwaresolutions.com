/**
 * Which payments the active keys can reach (lib/payments/key-scope.ts): reconcile and refunds keep covering payments
 * made with earlier keys of the same Razorpay mode (a key regeneration), never another mode or the mock's keys.
 */
import { describe, expect, it } from "vitest";
import { keysCanReach, reachablePaymentKeys } from "@/lib/payments/key-scope";

describe("keysCanReach", () => {
  it("accepts the same key id and payments from before key ids were recorded", () => {
    expect(keysCanReach("rzp_test_ActiveKey0001", "rzp_test_ActiveKey0001")).toBe(true);
    expect(keysCanReach(null, "rzp_live_ActiveKey0001")).toBe(true);
    expect(keysCanReach(null, "mock_key")).toBe(true);
  });

  it("accepts another Razorpay key id of the same mode (regenerated keys of the same account)", () => {
    expect(keysCanReach("rzp_test_OldKeyOfAcct01", "rzp_test_NewKeyOfAcct01")).toBe(true);
    expect(keysCanReach("rzp_live_OldKeyOfAcct01", "rzp_live_NewKeyOfAcct01")).toBe(true);
  });

  it("refuses the other mode, the mock's keys and malformed ids", () => {
    expect(keysCanReach("rzp_test_OldKeyOfAcct01", "rzp_live_NewKeyOfAcct01")).toBe(false);
    expect(keysCanReach("rzp_live_OldKeyOfAcct01", "rzp_test_NewKeyOfAcct01")).toBe(false);
    expect(keysCanReach("mock_other_account", "mock_key")).toBe(false);
    expect(keysCanReach("rzp_test_OldKeyOfAcct01", "mock_key")).toBe(false);
    expect(keysCanReach("rzp_test_pending", "rzp_test_NewKeyOfAcct01")).toBe(false);
  });
});

describe("reachablePaymentKeys", () => {
  it("builds the same rule as a Payment filter", () => {
    expect(reachablePaymentKeys("rzp_test_NewKeyOfAcct01")).toEqual({
      OR: [{ providerKeyId: null }, { providerKeyId: "rzp_test_NewKeyOfAcct01" }, { providerKeyId: { startsWith: "rzp_test_" } }],
    });
    expect(reachablePaymentKeys("mock_key")).toEqual({ OR: [{ providerKeyId: null }, { providerKeyId: "mock_key" }] });
  });
});
