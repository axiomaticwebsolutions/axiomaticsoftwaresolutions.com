import { describe, expect, it } from "vitest";

import {
  BILLING_ERRORS,
  BILLING_MAX,
  EMAIL_ERROR,
  GSTIN_RE,
  GST_STATE_CODES,
  INDIAN_MOBILE_RE,
  INDIAN_STATES,
  OTHER_TERRITORY,
  PASSWORD_ERROR,
  PIN_RE,
  billingSchema,
  cleanLine,
  emailSchema,
  gstCodeForState,
  gstinMatchesState,
  gstinStateMismatchMessage,
  gstinStateName,
  isAcceptablePassword,
  isEmailAddress,
  isGstinFormat,
  isIndianState,
  isValidGstin,
  normalizeGstin,
  normalizeIndianMobile,
  passwordSchema,
  stateForGstCode,
  tooLongMessage,
} from "@/lib/validation";

const SAMPLE_GSTINS: ReadonlyArray<readonly [string, string]> = [
  ["27ABCDE1234F1Z5", "Maharashtra"],
  ["36ABCDE5678G1Z2", "Telangana"],
  ["07ABCDE9012H1Z8", "Delhi"],
  ["29ABCDE3456J1Z4", "Karnataka"],
  ["24ABCDE7890K1Z6", "Gujarat"],
  ["09ABCDE2345L1Z1", "Uttar Pradesh"],
  ["19ABCDE1122N1Z7", "West Bengal"],
];

describe("states", () => {
  it("lists the 36 states and union territories in prototype order", () => {
    expect(INDIAN_STATES).toHaveLength(36);
    expect(new Set(INDIAN_STATES).size).toBe(36);
    expect(INDIAN_STATES[0]).toBe("Andaman and Nicobar Islands");
    expect(INDIAN_STATES[7]).toBe("Dadra and Nagar Haveli and Daman and Diu");
    expect(INDIAN_STATES[35]).toBe("West Bengal");
    expect(isIndianState("Maharashtra")).toBe(true);
    expect(isIndianState("maharashtra")).toBe(false);
    expect(isIndianState(OTHER_TERRITORY)).toBe(false);
    expect(isIndianState(27)).toBe(false);
  });

  it("has a current GST code for every billing state", () => {
    for (const state of INDIAN_STATES) {
      const code = gstCodeForState(state);
      expect(code, state).toMatch(/^\d{2}$/);
      expect(stateForGstCode(code ?? "")).toBe(state);
    }
  });

  it("maps new, merged and legacy codes", () => {
    expect(stateForGstCode("26")).toBe("Dadra and Nagar Haveli and Daman and Diu");
    expect(stateForGstCode("25")).toBe("Dadra and Nagar Haveli and Daman and Diu");
    expect(stateForGstCode("37")).toBe("Andhra Pradesh");
    expect(stateForGstCode("28")).toBe("Andhra Pradesh");
    expect(stateForGstCode("38")).toBe("Ladakh");
    expect(stateForGstCode("97")).toBe("Other Territory");
    expect(stateForGstCode(7)).toBe("Delhi");
    expect(stateForGstCode(" 27 ")).toBe("Maharashtra");
  });

  it("prefers the current code when mapping a state back", () => {
    expect(gstCodeForState("Andhra Pradesh")).toBe("37");
    expect(gstCodeForState("Dadra and Nagar Haveli and Daman and Diu")).toBe("26");
    expect(gstCodeForState("Telangana")).toBe("36");
    expect(gstCodeForState("Other Territory")).toBe("97");
    expect(gstCodeForState("Bombay")).toBeNull();
  });

  it("returns null for codes GSTN does not use", () => {
    for (const code of ["00", "39", "40", "96", "98", "99", "7", "270", "ab", "", "constructor", "__proto__"]) {
      expect(stateForGstCode(code), code).toBeNull();
    }
    expect(Object.keys(GST_STATE_CODES)).toHaveLength(39);
  });
});

describe("GSTIN", () => {
  it.each(SAMPLE_GSTINS)("accepts %s and maps it to %s", (gstin, state) => {
    expect(GSTIN_RE.test(gstin)).toBe(true);
    expect(isGstinFormat(gstin)).toBe(true);
    expect(isValidGstin(gstin)).toBe(true);
    expect(gstinStateName(gstin)).toBe(state);
    expect(gstinMatchesState(gstin, state)).toBe(true);
    expect(gstinMatchesState(gstin, state === "Kerala" ? "Goa" : "Kerala")).toBe(false);
  });

  it("normalises case and spaces", () => {
    expect(normalizeGstin(" 27abcde1234f1z5 ")).toBe("27ABCDE1234F1Z5");
    expect(normalizeGstin("27 ABCDE 1234 F1Z5")).toBe("27ABCDE1234F1Z5");
    expect(isGstinFormat("27abcde1234f1z5")).toBe(true);
    expect(gstinMatchesState(" 27abcde1234f1z5", "Maharashtra")).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["27ABCDE1234F1Z", "14 characters"],
    ["27ABCDE1234F1Z55", "16 characters"],
    ["2AABCDE1234F1Z5", "letter in the state code"],
    ["27ABCD11234F1Z5", "digit in the PAN letters"],
    ["27ABCDEX234F1Z5", "letter in the PAN digits"],
    ["27ABCDE123411Z5", "digit as the PAN check letter"],
    ["27ABCDE1234F0Z5", "entity number 0"],
    ["27ABCDE1234F1X5", "no Z in position 14"],
    ["27ABCDE1234F1Z-", "symbol as the check character"],
    ["27-ABCDE-1234F1Z5", "hyphens"],
  ])("rejects %s (%s)", (gstin) => {
    expect(isGstinFormat(gstin)).toBe(false);
    expect(isValidGstin(gstin)).toBe(false);
    expect(gstinStateName(gstin)).toBeNull();
    expect(gstinMatchesState(gstin, "Maharashtra")).toBe(false);
  });

  it("accepts the format but not an unused state code", () => {
    expect(isGstinFormat("00ABCDE1234F1Z5")).toBe(true);
    expect(isValidGstin("00ABCDE1234F1Z5")).toBe(false);
    expect(isValidGstin("99ABCDE1234F1Z5")).toBe(false);
  });

  it("matches legacy and special codes", () => {
    expect(gstinMatchesState("28ABCDE1234F1Z5", "Andhra Pradesh")).toBe(true);
    expect(gstinMatchesState("37ABCDE1234F1Z5", "Andhra Pradesh")).toBe(true);
    expect(gstinStateName("97ABCDE1234F1Z5")).toBe("Other Territory");
  });
});

describe("mobile numbers", () => {
  it.each([
    ["9820000000", "9820000000"],
    ["+91 98200 00000", "9820000000"],
    ["+919820000000", "9820000000"],
    ["91 98200 00000", "9820000000"],
    ["098200 00000", "9820000000"],
    ["0091 98200 00000", "9820000000"],
    ["(+91) 98200-00000", "9820000000"],
    [" 6000000000 ", "6000000000"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
    expect(INDIAN_MOBILE_RE.test(expected)).toBe(true);
  });

  it.each([
    "",
    "5820000000", // must start with 6-9
    "982000000", // 9 digits
    "98200000000", // 11 digits without a leading 0
    "+92 98200 00000", // other country code
    "020 2553 0000", // landline
    "98200abc00000",
    "9820000000 ext 1",
    "98+20000000",
    "+91 98200 00000 00000 0000",
  ])("rejects %j", (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });
});

describe("PIN codes", () => {
  it("accepts exactly six digits", () => {
    expect(PIN_RE.test("411004")).toBe(true);
    expect(PIN_RE.test("41100")).toBe(false);
    expect(PIN_RE.test("4110045")).toBe(false);
    expect(PIN_RE.test("41100a")).toBe(false);
    expect(PIN_RE.test("411 004")).toBe(false);
  });
});

describe("emailSchema", () => {
  it("trims and lower-cases", () => {
    expect(emailSchema.parse("  Priya@SharmaMedicals.Example ")).toBe("priya@sharmamedicals.example");
    expect(emailSchema.parse("o'brien+billing@firm.co.in")).toBe("o'brien+billing@firm.co.in");
  });

  it.each([
    "",
    "priya",
    "priya@",
    "@example.com",
    "priya@example",
    "priya@example.c",
    "priya@@example.com",
    "pri ya@example.com",
    "priya..s@example.com",
    ".priya@example.com",
    "priya@-example.com",
    "priya@example..com",
    `${"a".repeat(65)}@example.com`,
    `a@${"b".repeat(250)}.com`,
  ])("rejects %j with one message", (input) => {
    const result = emailSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([EMAIL_ERROR]);
  });

  it("rejects non-strings with the same message", () => {
    expect(emailSchema.safeParse(42).error?.issues[0]?.message).toBe("Enter a valid email address.");
    expect(isEmailAddress("a@b.co")).toBe(true);
  });
});

describe("passwordSchema", () => {
  it("accepts 8+ characters with a letter and a digit", () => {
    expect(passwordSchema.parse("Demo@1234")).toBe("Demo@1234");
    expect(passwordSchema.parse("abcdefg1")).toBe("abcdefg1");
    expect(isAcceptablePassword(`a1${"x".repeat(126)}`)).toBe(true);
    expect(passwordSchema.parse("  spaced 1  ")).toBe("  spaced 1  ");
  });

  it.each([
    ["short", "abc123"],
    ["7 characters", "abcdef1"],
    ["no digit", "abcdefgh"],
    ["no letter", "12345678"],
    ["only symbols and digits", "!!!!1234"],
    ["too long", `a1${"x".repeat(127)}`],
  ])("rejects %s with the single policy message", (_label, input) => {
    const result = passwordSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([PASSWORD_ERROR]);
  });

  it("uses the agreed copy", () => {
    expect(PASSWORD_ERROR).toBe("Use at least 8 characters with letters and a number.");
    expect(passwordSchema.safeParse(undefined).error?.issues[0]?.message).toBe(PASSWORD_ERROR);
  });
});

const VALID_BILLING = {
  name: "Priya Sharma",
  email: "priya@sharmamedicals.example",
  phone: "9820000000",
  business: "Sharma Medicals",
  address: "Shop 4, FC Road",
  city: "Pune",
  state: "Maharashtra",
  pin: "411004",
  gstin: "27ABCDE1234F1Z5",
};

/** First message per top-level field ("_" for object-level issues). */
function billingErrors(input: unknown): Record<string, string> {
  const result = billingSchema.safeParse(input);
  if (result.success) return {};
  const out: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "_";
    out[key] ??= issue.message;
  }
  return out;
}

describe("billingSchema", () => {
  it("accepts and normalises the sample customer", () => {
    const parsed = billingSchema.parse({
      ...VALID_BILLING,
      name: "  Priya   Sharma ",
      email: " Priya@SharmaMedicals.Example ",
      phone: "+91 98200 00000",
      gstin: " 27abcde1234f1z5 ",
    });
    expect(parsed).toEqual({ ...VALID_BILLING, name: "Priya Sharma" });
  });

  it("treats empty or missing optional fields as absent", () => {
    const parsed = billingSchema.parse({ ...VALID_BILLING, business: "", gstin: "" });
    expect(parsed.business).toBeUndefined();
    expect(parsed.gstin).toBeUndefined();
    const { business: _b, gstin: _g, ...required } = VALID_BILLING;
    const minimal = billingSchema.parse(required);
    expect(minimal.business).toBeUndefined();
    expect(minimal.gstin).toBeUndefined();
    expect(billingSchema.parse({ ...VALID_BILLING, business: null, gstin: null }).gstin).toBeUndefined();
    expect(billingSchema.parse({ ...VALID_BILLING, gstin: "   " }).gstin).toBeUndefined();
  });

  it("reports every required field with the checkout copy", () => {
    expect(billingErrors({})).toEqual({
      name: "Enter your full name.",
      email: "Enter a valid email address, like name@business.com.",
      phone: "Enter a 10-digit mobile number.",
      address: "Enter your billing address.",
      city: "Enter your city.",
      state: "Select your state or union territory.",
      pin: "PIN code should be 6 digits.",
    });
  });

  it.each([
    ["name", "   ", BILLING_ERRORS.name],
    ["name", "x".repeat(BILLING_MAX.name + 1), tooLongMessage(BILLING_MAX.name)],
    ["email", "priya@", BILLING_ERRORS.email],
    ["phone", "12345", BILLING_ERRORS.phone],
    ["phone", "5820000000", BILLING_ERRORS.phone],
    ["business", "x".repeat(BILLING_MAX.business + 1), tooLongMessage(BILLING_MAX.business)],
    ["address", "", BILLING_ERRORS.address],
    ["address", "x".repeat(BILLING_MAX.address + 1), tooLongMessage(BILLING_MAX.address)],
    ["city", " ", BILLING_ERRORS.city],
    ["city", "x".repeat(BILLING_MAX.city + 1), tooLongMessage(BILLING_MAX.city)],
    ["state", "", BILLING_ERRORS.state],
    ["state", "Bombay", BILLING_ERRORS.state],
    ["state", "maharashtra", BILLING_ERRORS.state],
    ["pin", "4110", BILLING_ERRORS.pin],
    ["pin", "41100a", BILLING_ERRORS.pin],
    ["gstin", "27ABCDE1234F1Z", BILLING_ERRORS.gstin],
    ["gstin", "00ABCDE1234F1Z5", BILLING_ERRORS.gstin],
    ["gstin", "27ABCDE1234F1Z5XXXXXXXX", BILLING_ERRORS.gstin],
    ["name", 42, BILLING_ERRORS.name],
  ])("rejects %s = %j", (field, value, message) => {
    expect(billingErrors({ ...VALID_BILLING, [field]: value })).toEqual({ [field]: message });
  });

  it("uses the agreed GSTIN format copy", () => {
    expect(BILLING_ERRORS.gstin).toBe("GSTIN should be 15 characters, like 27ABCDE1234F1Z5.");
  });

  it("rejects a GSTIN registered in another state", () => {
    expect(billingErrors({ ...VALID_BILLING, gstin: "36ABCDE5678G1Z2" })).toEqual({
      gstin: "This GSTIN is registered in Telangana. Choose Telangana as the billing state or check the GSTIN.",
    });
    expect(gstinStateMismatchMessage("Karnataka")).toBe(
      "This GSTIN is registered in Karnataka. Choose Karnataka as the billing state or check the GSTIN.",
    );
  });

  it.each(SAMPLE_GSTINS)("accepts %s billed to %s", (gstin, state) => {
    expect(billingErrors({ ...VALID_BILLING, gstin, state })).toEqual({});
  });

  it("accepts legacy codes and does not cross-check Other Territory", () => {
    expect(billingErrors({ ...VALID_BILLING, gstin: "28ABCDE1234F1Z5", state: "Andhra Pradesh" })).toEqual({});
    expect(billingErrors({ ...VALID_BILLING, gstin: "97ABCDE1234F1Z5" })).toEqual({});
  });

  it("reports a GSTIN mismatch together with other field errors", () => {
    expect(billingErrors({ ...VALID_BILLING, name: "", gstin: "29ABCDE3456J1Z4" })).toEqual({
      name: BILLING_ERRORS.name,
      gstin: gstinStateMismatchMessage("Karnataka"),
    });
  });

  it("skips the mismatch check when the state itself is invalid", () => {
    expect(billingErrors({ ...VALID_BILLING, state: "", gstin: "29ABCDE3456J1Z4" })).toEqual({
      state: BILLING_ERRORS.state,
    });
  });

  it("rejects unknown keys (strict)", () => {
    const result = billingSchema.safeParse({ ...VALID_BILLING, isAdmin: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("rejects non-object input without throwing", () => {
    for (const input of [null, undefined, "billing", 42, []]) {
      expect(billingSchema.safeParse(input).success).toBe(false);
    }
  });

  it("collapses control characters and line breaks in text fields", () => {
    const parsed = billingSchema.parse({ ...VALID_BILLING, name: "Priya\tSharma", address: "Shop 4,\r\nFC Road\u0000" });
    expect(parsed.name).toBe("Priya Sharma");
    expect(parsed.address).toBe("Shop 4, FC Road");
    expect(cleanLine("  a \u0085 b\u2028c  ")).toBe("a b c");
  });
});
