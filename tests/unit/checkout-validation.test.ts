import { describe, expect, it } from "vitest";
import {
  CHECKOUT_ERRORS,
  createOrderRequestSchema,
  isOrderIdShape,
  orderActionRequestSchema,
  orderReturnRequestSchema,
  quoteRequestSchema,
} from "@/lib/validation/checkout";
import { BILLING_ERRORS, gstinStateMismatchMessage } from "@/lib/validation/billing";
import { PASSWORD_ERROR } from "@/lib/validation/password";
import { zodFieldErrors } from "@/lib/http";

const billing = {
  name: "Priya Sharma",
  email: "Priya@SharmaMedicals.example",
  phone: "+91 98200 00000",
  address: "12 MG Road",
  city: "Pune",
  state: "Maharashtra",
  pin: "411001",
};

type Parser = { safeParse: (v: unknown) => { success: boolean; error?: unknown } };

function fieldErrors(schema: Parser, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  return zodFieldErrors(result.error as Parameters<typeof zodFieldErrors>[0]).fieldErrors;
}

describe("quoteRequestSchema", () => {
  it("accepts items, normalises the coupon and a blank state", () => {
    const parsed = quoteRequestSchema.parse({
      items: [
        { planId: "med-annual", qty: 1 },
        { planId: "med-annual", qty: 1, kind: "RENEWAL", targetLicenseId: "LIC-24017" },
      ],
      couponCode: "  welcome10 ",
      billingState: "",
    });
    expect(parsed.couponCode).toBe("WELCOME10");
    expect(parsed.billingState).toBeNull();
    expect(quoteRequestSchema.parse({ items: [], couponCode: "   " }).couponCode).toBeNull();
  });

  it("never accepts prices or unknown keys from the client", () => {
    expect(fieldErrors(quoteRequestSchema, { items: [{ planId: "med-annual", qty: 1, unitPricePaise: 1 }] })).toEqual({
      "items.0.unitPricePaise": ["Unknown field."],
    });
    expect(fieldErrors(quoteRequestSchema, { items: [], totalPaise: 1 })).toEqual({ totalPaise: ["Unknown field."] });
  });

  it("rejects bad quantities, kinds, ids and states", () => {
    const errs = fieldErrors(quoteRequestSchema, {
      items: [
        { planId: "med-annual", qty: 0 },
        { planId: "med-annual", qty: 1.5 },
        { planId: "med annual", qty: 1 },
        { planId: "med-annual", qty: 1, kind: "GIFT" },
        { planId: "med-annual", qty: 100 },
      ],
      billingState: "Atlantis",
    });
    expect(Object.keys(errs).sort()).toEqual(["billingState", "items.0.qty", "items.1.qty", "items.2.planId", "items.3.kind", "items.4.qty"]);
    expect(errs.billingState).toEqual([BILLING_ERRORS.state]);
  });

  it("caps the number of lines", () => {
    const items = Array.from({ length: 51 }, () => ({ planId: "med-annual", qty: 1 }));
    expect(fieldErrors(quoteRequestSchema, { items }).items).toEqual([CHECKOUT_ERRORS.tooManyLines]);
  });
});

describe("createOrderRequestSchema", () => {
  const base = { items: [{ planId: "med-annual", qty: 1 }], billing, acceptTerms: true };

  it("parses billing into the stored shape", () => {
    const parsed = createOrderRequestSchema.parse({
      ...base,
      billing: { ...billing, gstin: "27abcde1234f1z5", business: "  Sharma  Medicals " },
    });
    expect(parsed.billing).toMatchObject({
      email: "priya@sharmamedicals.example",
      phone: "9820000000",
      gstin: "27ABCDE1234F1Z5",
      business: "Sharma Medicals",
    });
    expect(parsed.createAccount).toBeUndefined();
  });

  it("requires items, accepted terms and valid billing", () => {
    const errs = fieldErrors(createOrderRequestSchema, {
      items: [],
      billing: { ...billing, pin: "41100", email: "nope" },
      acceptTerms: false,
    });
    expect(errs.items).toEqual([CHECKOUT_ERRORS.emptyCart]);
    expect(errs.acceptTerms).toEqual([CHECKOUT_ERRORS.acceptTerms]);
    expect(errs["billing.pin"]).toEqual([BILLING_ERRORS.pin]);
    expect(errs["billing.email"]).toEqual([BILLING_ERRORS.email]);
    expect(fieldErrors(createOrderRequestSchema, { items: base.items, billing }).acceptTerms).toEqual([CHECKOUT_ERRORS.acceptTerms]);
  });

  it("checks the GSTIN against the billing state", () => {
    const errs = fieldErrors(createOrderRequestSchema, { ...base, billing: { ...billing, gstin: "29ABCDE1234F1Z5" } });
    expect(errs["billing.gstin"]).toEqual([gstinStateMismatchMessage("Karnataka")]);
  });

  it("applies the password policy to createAccount", () => {
    const weak = fieldErrors(createOrderRequestSchema, { ...base, createAccount: { password: "12345678" } });
    expect(weak["createAccount.password"]).toEqual([PASSWORD_ERROR]);
    const ok = createOrderRequestSchema.parse({ ...base, createAccount: { password: "s3cure-pass" } });
    expect(ok.createAccount).toEqual({ password: "s3cure-pass" });
    expect(fieldErrors(createOrderRequestSchema, { ...base, createAccount: { password: "s3cure-pass", role: "OWNER" } })).toEqual({
      "createAccount.role": ["Unknown field."],
    });
  });
});

describe("order action schemas", () => {
  it("accepts an optional token and nothing else", () => {
    expect(orderActionRequestSchema.parse({})).toEqual({});
    expect(orderActionRequestSchema.parse({ t: "o1.x.y.z" })).toEqual({ t: "o1.x.y.z" });
    expect(orderActionRequestSchema.safeParse({ t: "x".repeat(257) }).success).toBe(false);
    expect(orderActionRequestSchema.safeParse({ status: "PAID" }).success).toBe(false);
  });

  it("validates the payment return payload", () => {
    expect(orderReturnRequestSchema.parse({ providerPaymentId: "pay_mock_1", providerSignature: "ab12" })).toEqual({
      providerPaymentId: "pay_mock_1",
      providerSignature: "ab12",
    });
    const errs = fieldErrors(orderReturnRequestSchema, { providerPaymentId: "pay 1", providerSignature: "" });
    expect(Object.keys(errs).sort()).toEqual(["providerPaymentId", "providerSignature"]);
  });

  it("recognises order id shapes", () => {
    expect(isOrderIdShape("AX-10312")).toBe(true);
    for (const bad of ["", "../x", "AX 1", "a".repeat(65), 12]) expect(isOrderIdShape(bad)).toBe(false);
  });
});
