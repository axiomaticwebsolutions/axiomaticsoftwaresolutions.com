import { describe, expect, it } from "vitest";

import {
  DEFAULT_GST_RATE_PCT,
  RUPEE,
  assertPaise,
  formatINR,
  paiseToDecimalString,
  rupeesToPaise,
  withTax,
} from "@/lib/money";

describe("formatINR", () => {
  it("prints whole rupees without paise", () => {
    expect(formatINR(499900)).toBe("₹4,999");
    expect(formatINR(0)).toBe("₹0");
    expect(formatINR(100)).toBe("₹1");
  });

  it("prints paise when there are any", () => {
    expect(formatINR(589882)).toBe("₹5,898.82");
    expect(formatINR(5)).toBe("₹0.05");
    expect(formatINR(130050)).toBe("₹1,300.50");
  });

  it("prints two decimals when exact is set", () => {
    expect(formatINR(499900, { exact: true })).toBe("₹4,999.00");
    expect(formatINR(0, { exact: true })).toBe("₹0.00");
  });

  it("uses Indian digit grouping (lakh, crore)", () => {
    expect(formatINR(1234567800)).toBe("₹1,23,45,678");
    expect(formatINR(10000000)).toBe("₹1,00,000");
    expect(formatINR(1000000000)).toBe("₹1,00,00,000");
    expect(formatINR(1234567890)).toBe("₹1,23,45,678.90");
  });

  it("puts the minus sign before the rupee sign", () => {
    expect(formatINR(-499900)).toBe("-₹4,999");
    expect(formatINR(-589882)).toBe("-₹5,898.82");
    expect(formatINR(-50, { exact: true })).toBe("-₹0.50");
  });

  it("uses the real rupee sign (U+20B9)", () => {
    expect(RUPEE).toBe("\u20B9");
    expect(formatINR(100).startsWith("\u20B9")).toBe(true);
  });

  it("rejects non-integer paise", () => {
    expect(() => formatINR(1.5)).toThrow(TypeError);
    expect(() => formatINR(Number.NaN)).toThrow(TypeError);
  });
});

describe("withTax", () => {
  it("adds 18% GST by default and rounds to the paisa", () => {
    expect(DEFAULT_GST_RATE_PCT).toBe(18);
    expect(withTax(499900)).toBe(589882);
    expect(formatINR(withTax(499900))).toBe("₹5,898.82");
    expect(withTax(69900)).toBe(82482);
    expect(withTax(1)).toBe(1); // 1.18 rounds down
    expect(withTax(3)).toBe(4); // 3.54 rounds up
  });

  it("supports other rates", () => {
    expect(withTax(10000, 0)).toBe(10000);
    expect(withTax(10000, 5)).toBe(10500);
    expect(withTax(10000, 12)).toBe(11200);
  });

  it("rejects non-integer paise", () => {
    expect(() => withTax(10.5)).toThrow(TypeError);
  });
});

describe("paiseToDecimalString", () => {
  it("formats for CSV without grouping or symbol", () => {
    expect(paiseToDecimalString(499900)).toBe("4999.00");
    expect(paiseToDecimalString(589882)).toBe("5898.82");
    expect(paiseToDecimalString(5)).toBe("0.05");
    expect(paiseToDecimalString(0)).toBe("0.00");
    expect(paiseToDecimalString(1234567800)).toBe("12345678.00");
  });

  it("handles negatives", () => {
    expect(paiseToDecimalString(-150)).toBe("-1.50");
    expect(paiseToDecimalString(-5)).toBe("-0.05");
  });
});

describe("assertPaise", () => {
  it("accepts safe integers", () => {
    expect(() => assertPaise(0)).not.toThrow();
    expect(() => assertPaise(-100)).not.toThrow();
    expect(() => assertPaise(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it("rejects fractions, NaN, infinities and unsafe integers", () => {
    expect(() => assertPaise(1.5)).toThrow(TypeError);
    expect(() => assertPaise(Number.NaN)).toThrow(TypeError);
    expect(() => assertPaise(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => assertPaise(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });
});

describe("rupeesToPaise", () => {
  it("converts and rounds to the paisa", () => {
    expect(rupeesToPaise(4999)).toBe(499900);
    expect(rupeesToPaise(5898.82)).toBe(589882);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
  });
});
