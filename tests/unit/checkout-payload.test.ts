import { describe, expect, it } from "vitest";
import { checkoutPayload, mockCheckoutUrl } from "@/lib/checkout/payment-attempt";
import { lineLabel } from "@/lib/checkout/quote";
import { CHECKOUT_TERMS_VERSION } from "@/lib/checkout/create-order";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { PaymentProviderError } from "@/lib/payments/types";

const billing = readBillingSnapshot({
  name: "Priya Sharma",
  email: "priya@sharmamedicals.example",
  phone: "9820000000",
  address: "12 MG Road",
  city: "Pune",
  state: "Maharashtra",
  pin: "411001",
});
const order = { id: "AX-10312", totalPaise: 589_882, billing };

describe("checkout payload", () => {
  it("points the mock provider at the dev checkout page with the order link", () => {
    expect(mockCheckoutUrl("AX-10312", "o1.a.b.c")).toBe("/dev/mock-checkout?order=AX-10312&t=o1.a.b.c");
    expect(checkoutPayload("mock", { providerOrderId: "order_mock_1", checkout: { url: "/ignored" } }, order, "o1.a.b.c")).toEqual({
      kind: "mock",
      url: "/dev/mock-checkout?order=AX-10312&t=o1.a.b.c",
    });
  });

  it("builds Razorpay Checkout options from server data", () => {
    expect(checkoutPayload("razorpay", { providerOrderId: "order_Rz1", checkout: { keyId: "rzp_test_1" } }, order, "t")).toEqual({
      kind: "razorpay",
      keyId: "rzp_test_1",
      providerOrderId: "order_Rz1",
      amountPaise: 589_882,
      currency: "INR",
      name: "Axiomatic Software Solutions",
      description: "Order AX-10312",
      prefill: { name: "Priya Sharma", email: "priya@sharmamedicals.example", contact: "9820000000" },
    });
  });

  it("refuses providers without a client checkout", () => {
    expect(() => checkoutPayload("cashfree", { providerOrderId: "cf_1" }, order, "t")).toThrow(PaymentProviderError);
  });
});

describe("order helpers", () => {
  it("labels cart lines like the cart prototype", () => {
    expect(lineLabel("NEW", "Annual license", 1, null)).toBe("Annual license");
    expect(lineLabel("NEW", "Per-terminal license", 3, null)).toBe("Per-terminal license × 3");
    expect(lineLabel("RENEWAL", "Annual license", 1, "LIC-24017")).toBe("Renewal of LIC-24017");
    expect(lineLabel("UPGRADE", "Annual license", 1, "LIC-24017")).toBe("Upgrade of LIC-24017");
    expect(lineLabel("ADDON", "Additional computer", 2, "LIC-24017")).toBe("Add-on for LIC-24017");
  });

  it("records the versions of the documents accepted at checkout", () => {
    expect(CHECKOUT_TERMS_VERSION).toMatch(/^terms@[0-9.]+,eula@[0-9.]+,refund@[0-9.]+$/);
  });

  it("reads stored billing snapshots leniently", () => {
    expect(readBillingSnapshot(null)).toMatchObject({ name: "", business: null, gstin: null });
    expect(readBillingSnapshot({ name: "A", gstin: "", business: "B" })).toMatchObject({ name: "A", gstin: null, business: "B" });
  });
});

describe("shared copy", () => {
  it("matches the guards' team and account messages", async () => {
    const guards = await import("@/lib/auth/guards");
    const buyer = await import("@/lib/checkout/buyer");
    expect(buyer.PURCHASE_FORBIDDEN_MESSAGE).toBe(guards.TEAM_FORBIDDEN_MESSAGE);
    expect(buyer.NO_ACCOUNT_MESSAGE).toBe(guards.NO_ACCOUNT_MESSAGE);
  });
});
