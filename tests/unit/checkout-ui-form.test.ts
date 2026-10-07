import { describe, expect, it } from "vitest";
import {
  CHECKOUT_ERRORS,
  CHECKOUT_FIELD_ORDER,
  EMPTY_CHECKOUT_VALUES,
  gstinHelper,
  initialsOf,
  isIntraState,
  mapServerFieldErrors,
  passwordHelper,
  sanitizeGstinInput,
  taxNote,
  toCreateOrderBody,
  validateCheckout,
  type CheckoutValues,
} from "@/components/checkout/checkout-form";
import { createOrderRequestSchema } from "@/lib/validation/checkout";

const valid: CheckoutValues = {
  ...EMPTY_CHECKOUT_VALUES,
  name: "Priya Sharma",
  email: "Priya@SharmaMedicals.example ",
  phone: "+91 98200 00000",
  business: "Sharma Medicals",
  address: "Shop 4, FC Road",
  city: "Pune",
  pin: "411004",
  state: "Maharashtra",
  agree: true,
};

const items = [{ planId: "med-annual", qty: 1, kind: "NEW" as const, targetLicenseId: null }];

describe("validateCheckout (Checkout.dc.html copy, server rules)", () => {
  it("accepts a complete form", () => {
    expect(validateCheckout(valid, { guest: true })).toEqual({});
  });

  it("reports every empty required field with the prototype copy", () => {
    const errors = validateCheckout(EMPTY_CHECKOUT_VALUES, { guest: true });
    expect(errors).toEqual({
      name: "Enter your full name.",
      email: "Enter a valid email address, like name@business.com.",
      phone: "Enter a 10-digit mobile number.",
      address: "Enter your billing address.",
      city: "Enter your city.",
      pin: "PIN code should be 6 digits.",
      state: "Select your state or union territory.",
      agree: "Please accept the license agreement to continue.",
    });
    // Summary order follows the form.
    expect(Object.keys(errors).every((k) => CHECKOUT_FIELD_ORDER.includes(k as never))).toBe(true);
  });

  it("checks mobile numbers like the server (6-9 start, +91 and 0 prefixes)", () => {
    expect(validateCheckout({ ...valid, phone: "09820000000" }, { guest: true }).phone).toBeUndefined();
    expect(validateCheckout({ ...valid, phone: "5820000000" }, { guest: true }).phone).toBe(CHECKOUT_ERRORS.phone);
    expect(validateCheckout({ ...valid, phone: "98200" }, { guest: true }).phone).toBe(CHECKOUT_ERRORS.phone);
  });

  it("asks guests creating an account for a policy password only", () => {
    const create = { ...valid, createAccount: true };
    expect(validateCheckout({ ...create, password: "12345678" }, { guest: true }).password).toBe(
      "Use at least 8 characters with letters and a number.",
    );
    expect(validateCheckout({ ...create, password: "abcdefg1" }, { guest: true }).password).toBeUndefined();
    expect(validateCheckout({ ...create, password: "" }, { guest: false }).password).toBeUndefined();
  });

  it("validates the GSTIN only while its toggle is on, including the billing-state check", () => {
    expect(validateCheckout({ ...valid, gstin: "nonsense" }, { guest: true }).gstin).toBeUndefined();
    const withGstin = { ...valid, hasGstin: true };
    expect(validateCheckout({ ...withGstin, gstin: "27ABCDE12" }, { guest: true }).gstin).toBe("Enter a valid 15-character GSTIN.");
    expect(validateCheckout({ ...withGstin, gstin: "99ABCDE1234F1Z5" }, { guest: true }).gstin).toBe(CHECKOUT_ERRORS.gstin);
    expect(validateCheckout({ ...withGstin, gstin: "27ABCDE1234F1Z5" }, { guest: true }).gstin).toBeUndefined();
    expect(validateCheckout({ ...withGstin, gstin: "27ABCDE1234F1Z5", state: "Karnataka" }, { guest: true }).gstin).toBe(
      "This GSTIN is registered in Maharashtra. Choose Maharashtra as the billing state or check the GSTIN.",
    );
  });

  it("limits lengths like the server", () => {
    expect(validateCheckout({ ...valid, name: "x".repeat(101) }, { guest: true }).name).toBe("Use 100 characters or fewer.");
    expect(validateCheckout({ ...valid, business: "x".repeat(121) }, { guest: true }).business).toBe("Use 120 characters or fewer.");
  });
});

describe("helper lines", () => {
  it("walks the GSTIN states of the prototype", () => {
    expect(gstinHelper("", "")).toEqual({ message: "Format: 2-digit state code, PAN, entity number, Z, checksum.", tone: "neutral" });
    expect(gstinHelper("27ABCDE12", "").message).toBe("6 more characters");
    expect(gstinHelper("27ABCDE1234F1Z", "").message).toBe("1 more character");
    expect(gstinHelper("27ABCDE1234F1Y5", "")).toEqual({ message: "This doesn’t look like a valid GSTIN.", tone: "neutral" });
    expect(gstinHelper("27ABCDE1234F1Z5", "")).toEqual({ message: "Valid format · Maharashtra", tone: "valid" });
    expect(gstinHelper("29ABCDE1234F1Z5", "Karnataka")).toEqual({ message: "Valid format · Karnataka", tone: "valid" });
    expect(gstinHelper("27ABCDE1234F1Z5", "Goa").message).toMatch(/registered in Maharashtra/);
    expect(gstinHelper("27ABCDE1234F1Z5", "", "Enter a valid 15-character GSTIN.").tone).toBe("error");
  });

  it("sanitises GSTIN input like the prototype", () => {
    expect(sanitizeGstinInput("27abc de-1234f1z5xx")).toBe("27ABCDE1234F1Z5");
  });

  it("shows password strength", () => {
    expect(passwordHelper("abc")).toEqual({ message: "At least 8 characters with letters and a number", tone: "neutral" });
    expect(passwordHelper("abcdefg1")).toEqual({ message: "Strong enough", tone: "valid" });
    expect(passwordHelper("abcdefg1", "Use at least 8 characters with letters and a number.").tone).toBe("error");
  });

  it("explains the tax type for the chosen state", () => {
    expect(taxNote("", "Maharashtra")).toBe("Select your state to confirm the tax type.");
    expect(taxNote("Maharashtra", "Maharashtra")).toBe("Intra-state supply (Maharashtra): CGST + SGST.");
    expect(taxNote("Karnataka", "Maharashtra")).toBe("Inter-state supply to Karnataka: IGST.");
    expect(isIntraState("", "Maharashtra")).toBe(true);
    expect(isIntraState("Goa", "Maharashtra")).toBe(false);
  });

  it("makes avatar initials", () => {
    expect(initialsOf("Priya Sharma")).toBe("PS");
    expect(initialsOf("  anita  ")).toBe("A");
    expect(initialsOf("Ravi Kumar Rao")).toBe("RK");
  });
});

describe("toCreateOrderBody", () => {
  it("builds a body the order API schema accepts", () => {
    const body = toCreateOrderBody({ ...valid, hasGstin: true, gstin: "27abcde1234f1z5" }, items, { couponCode: "WELCOME10", guest: true });
    expect(body).toEqual({
      items,
      couponCode: "WELCOME10",
      billing: {
        name: "Priya Sharma",
        email: "priya@sharmamedicals.example",
        phone: "+91 98200 00000",
        business: "Sharma Medicals",
        address: "Shop 4, FC Road",
        city: "Pune",
        state: "Maharashtra",
        pin: "411004",
        gstin: "27ABCDE1234F1Z5",
      },
      acceptTerms: true,
    });
    expect(createOrderRequestSchema.safeParse(body).success).toBe(true);
  });

  it("leaves out an empty business, a GSTIN whose toggle is off, the coupon and a signed-in password", () => {
    const body = toCreateOrderBody(
      { ...valid, business: "  ", hasGstin: false, gstin: "27ABCDE1234F1Z5", createAccount: true, password: "abcdefg1" },
      items,
      { couponCode: null, guest: false },
    );
    expect(body.billing.business).toBeUndefined();
    expect(body.billing.gstin).toBeUndefined();
    expect(body.couponCode).toBeUndefined();
    expect(body.createAccount).toBeUndefined();
    expect(createOrderRequestSchema.safeParse(body).success).toBe(true);
  });

  it("sends the password for guests creating an account", () => {
    const body = toCreateOrderBody({ ...valid, createAccount: true, password: "abcdefg1" }, items, { couponCode: null, guest: true });
    expect(body.createAccount).toEqual({ password: "abcdefg1" });
    expect(createOrderRequestSchema.safeParse(body).success).toBe(true);
  });
});

describe("mapServerFieldErrors", () => {
  it("maps billing paths to fields and keeps the coupon message apart", () => {
    expect(
      mapServerFieldErrors({
        "billing.gstin": ["GSTIN should be 15 characters, like 27ABCDE1234F1Z5."],
        "billing.email": ["Enter a valid email address, like name@business.com."],
        "createAccount.password": ["Use at least 8 characters with letters and a number."],
        acceptTerms: ["Please accept the license agreement to continue."],
        couponCode: ["This code expired on 31 Aug 2026."],
        items: ["Your cart is empty."],
      }),
    ).toEqual({
      fields: {
        gstin: "GSTIN should be 15 characters, like 27ABCDE1234F1Z5.",
        email: "Enter a valid email address, like name@business.com.",
        password: "Use at least 8 characters with letters and a number.",
        agree: "Please accept the license agreement to continue.",
      },
      coupon: "This code expired on 31 Aug 2026.",
      other: "Your cart is empty.",
    });
  });
});
