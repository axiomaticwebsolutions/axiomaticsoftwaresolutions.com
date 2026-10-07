import { describe, expect, it } from "vitest";
import {
  BILLING_COPY,
  billingFormValues,
  billingPatchBody,
  billingServerErrors,
  firstInvalidField,
  gstinHelper,
  istIsoDate,
  PAYMENT_CSV_COLUMNS,
  paymentAmountLabel,
  paymentDateLabel,
  paymentMethodLabel,
  paymentsTruncatedLabel,
  validateBillingForm,
  type BillingFormValues,
  type PaymentHistoryRow,
} from "@/components/account/billing/billing-model";
import { toCsv } from "@/lib/csv";
import { billingDetailsIssue, billingDetailsSchema, PORTAL_ERRORS } from "@/lib/validation/portal";

const SAVED: BillingFormValues = {
  legalName: "Sharma Medicals",
  gstin: "27ABCDE1234F1Z5",
  state: "Maharashtra",
  address: "Shop 4, FC Road",
  city: "Pune",
  pin: "411004",
};
const form = (patch: Partial<BillingFormValues>): BillingFormValues => ({ ...SAVED, ...patch });

describe("billing form values", () => {
  it("shows empty optional fields as blank inputs", () => {
    expect(billingFormValues({ legalName: "Kiran Stores", gstin: null, address: null, city: null, state: null, pin: null })).toEqual({
      legalName: "Kiran Stores",
      gstin: "",
      state: "",
      address: "",
      city: "",
      pin: "",
    });
  });

  it("sends every field, cleaned, with null for blanks", () => {
    expect(billingPatchBody(form({ legalName: "  Sharma   Medicals ", gstin: " 27abcde1234f1z5 ", address: "", city: " Pune ", pin: "" }))).toEqual({
      legalName: "Sharma Medicals",
      gstin: "27ABCDE1234F1Z5",
      address: null,
      city: "Pune",
      state: "Maharashtra",
      pin: null,
    });
  });
});

describe("validateBillingForm", () => {
  it("accepts the saved details and blank optional fields", () => {
    expect(validateBillingForm(SAVED)).toEqual({});
    expect(validateBillingForm(form({ gstin: "", state: "", address: "", city: "", pin: "" }))).toEqual({});
  });

  it("uses the prototype's GSTIN and PIN copy", () => {
    expect(validateBillingForm(form({ gstin: "27ABCDE", pin: "4110" }))).toEqual({
      gstin: "Enter a valid 15-character GSTIN or leave it blank.",
      pin: "PIN code should be 6 digits.",
    });
  });

  it("requires a legal name within the length limit", () => {
    expect(validateBillingForm(form({ legalName: "   " })).legalName).toBe(PORTAL_ERRORS.legalName);
    expect(validateBillingForm(form({ legalName: "A".repeat(500) })).legalName).toBe(PORTAL_ERRORS.legalNameTooLong);
  });

  it("checks the GSTIN against the State / UT", () => {
    expect(validateBillingForm(form({ gstin: "29ABCDE1234F1Z5" }))).toEqual({
      gstin: "This GSTIN is registered in Karnataka. Choose Karnataka as the billing state or check the GSTIN.",
    });
    expect(validateBillingForm(form({ state: "" }))).toEqual({ state: PORTAL_ERRORS.gstinNeedsState });
    expect(validateBillingForm(form({ state: "Atlantis" }))).toEqual({ state: PORTAL_ERRORS.state });
    expect(validateBillingForm(form({ gstin: "27abcde1234f1z5" }))).toEqual({});
  });

  it("limits the address and city", () => {
    expect(validateBillingForm(form({ address: "x".repeat(301), city: "y".repeat(81) }))).toEqual({
      address: PORTAL_ERRORS.addressTooLong,
      city: PORTAL_ERRORS.cityTooLong,
    });
  });

  it("agrees with the API's schema and GSTIN/state rule", () => {
    const cases: Partial<BillingFormValues>[] = [
      {},
      { gstin: "" },
      { gstin: "27ABCDE" },
      { gstin: "29ABCDE1234F1Z5" },
      { state: "" },
      { pin: "41100" },
      { pin: "" },
      { legalName: "" },
      { gstin: "07AAACB1234C1Z9", state: "Delhi" },
    ];
    for (const patch of cases) {
      const values = form(patch);
      const parsed = billingDetailsSchema.safeParse(billingPatchBody(values));
      const serverOk = parsed.success && billingDetailsIssue({ gstin: parsed.data.gstin ?? null, state: parsed.data.state ?? null }) === null;
      expect({ patch, ok: Object.keys(validateBillingForm(values)).length === 0 }).toEqual({ patch, ok: serverOk });
    }
  });

  it("focuses fields in form order", () => {
    expect(firstInvalidField({ pin: "x", gstin: "y" })).toBe("gstin");
    expect(firstInvalidField({})).toBeNull();
  });

  it("maps the API's field errors and ignores unknown keys", () => {
    expect(billingServerErrors({ gstin: ["Bad GSTIN.", "second"], other: ["x"], pin: [] })).toEqual({ gstin: "Bad GSTIN." });
  });
});

describe("gstinHelper (live line)", () => {
  it("counts the remaining characters and confirms a valid GSTIN", () => {
    expect(gstinHelper("", "Maharashtra")).toBeNull();
    expect(gstinHelper("27ABCDE1234F1Z", "Maharashtra")).toEqual({ message: "1 more character", tone: "neutral" });
    expect(gstinHelper("27ABC", "")).toEqual({ message: "10 more characters", tone: "neutral" });
    expect(gstinHelper("27ABCDE1234F1Z5", "Maharashtra")).toEqual({ message: "Valid format · Maharashtra", tone: "valid" });
    expect(gstinHelper("27ABCDE1234F1Z5", "")).toEqual({ message: "Valid format · Maharashtra", tone: "valid" });
  });

  it("flags an invalid GSTIN or another state, and lets an error win", () => {
    expect(gstinHelper("27ABCDE1234F1A5", "Maharashtra")).toEqual({ message: PORTAL_ERRORS.gstin, tone: "neutral" });
    expect(gstinHelper("29ABCDE1234F1Z5", "Maharashtra")?.message).toContain("registered in Karnataka");
    expect(gstinHelper("27ABCDE1234F1Z5", "Maharashtra", "Server says no.")).toEqual({ message: "Server says no.", tone: "error" });
  });
});

describe("payment history", () => {
  const row: PaymentHistoryRow = {
    id: "seed_pay_AX-10288",
    reference: "pay_SAMPLE_10288",
    orderId: "AX-10288",
    createdAt: "2026-10-06T19:00:00.000Z",
    method: "UPI",
    status: "REFUNDED",
    badge: { label: "Refunded", tone: "lavender" },
    amountPaise: 412882,
  };

  it("formats rows in IST with paise", () => {
    expect(paymentDateLabel(row)).toBe("7 Oct 2026");
    expect(istIsoDate(row.createdAt)).toBe("2026-10-07");
    expect(paymentAmountLabel(row)).toBe("₹4,128.82");
    expect(paymentMethodLabel(row)).toBe("UPI");
    expect(paymentMethodLabel({ method: null })).toBe("—");
  });

  it("exports payments.csv with the prototype's columns", () => {
    const csv = toCsv([row, { ...row, id: "p2", reference: "=HYPERLINK()", method: null, amountPaise: 5 }], PAYMENT_CSV_COLUMNS, { bom: false });
    expect(csv.split("\r\n")).toEqual([
      '"Date","Payment ID","Order","Method","Status","Amount"',
      '"2026-10-07","pay_SAMPLE_10288","AX-10288","UPI","Refunded","4128.82"',
      `"2026-10-07","'=HYPERLINK()","AX-10288","","Refunded","0.05"`,
      "",
    ]);
  });

  it("says when only the newest payments are listed", () => {
    expect(paymentsTruncatedLabel(100)).toBe("Showing the latest 100 payments.");
  });

  it("never promises automatic renewal (decisions.md rule 2)", () => {
    expect(BILLING_COPY.methodsBody).not.toMatch(/mandate|auto-?renew|automatically renew/i);
    expect(BILLING_COPY.methodsBody).toContain("We don’t store cards or UPI IDs.");
  });
});
