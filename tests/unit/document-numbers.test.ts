import { describe, expect, it } from "vitest";
import { SETTING_DEFAULTS, settingSchemas } from "@/lib/config";
import {
  DocumentSeriesExhaustedError,
  GST_DOCUMENT_NUMBER_MAX_LENGTH,
  compareDocumentNumbers,
  documentSeriesCapacity,
  formatDocumentNumber,
} from "@/lib/counters";

describe("formatDocumentNumber", () => {
  it("formats prefix / FY / running number padded to 4 digits", () => {
    expect(formatDocumentNumber("AXS", "26-27", 1181)).toBe("AXS/26-27/1181");
    expect(formatDocumentNumber("AXC", "27-28", 1)).toBe("AXC/27-28/0001");
    expect(formatDocumentNumber("AXS", "26-27", 123456)).toBe("AXS/26-27/123456");
  });

  it("never returns more than 16 characters (CGST Rules 46(b) and 53)", () => {
    expect(formatDocumentNumber("AXS", "26-27", 999_999)).toHaveLength(GST_DOCUMENT_NUMBER_MAX_LENGTH);
    expect(() => formatDocumentNumber("AXS", "26-27", 1_000_000)).toThrow(DocumentSeriesExhaustedError);
    expect(formatDocumentNumber("AX", "26-27", 9_999_999)).toHaveLength(16);
    expect(() => formatDocumentNumber("AX", "26-27", 10_000_000)).toThrow(DocumentSeriesExhaustedError);
    for (const prefix of ["A", "AX", "AXS", "A-1"]) {
      const capacity = documentSeriesCapacity(prefix);
      expect(formatDocumentNumber(prefix, "26-27", capacity).length).toBeLessThanOrEqual(16);
      expect(() => formatDocumentNumber(prefix, "26-27", capacity + 1)).toThrow(DocumentSeriesExhaustedError);
    }
  });

  it("allows at least 999,999 documents per financial year for every valid prefix", () => {
    expect(documentSeriesCapacity("AXS")).toBe(999_999);
    expect(documentSeriesCapacity("AX")).toBe(9_999_999);
  });

  it("refuses prefixes that could not keep the 16-character limit, and bad input", () => {
    for (const prefix of ["AXSI", "AXSIN", "", "axs", "AX/S"]) {
      expect(() => formatDocumentNumber(prefix, "26-27", 1), prefix).toThrow(RangeError);
    }
    expect(() => formatDocumentNumber("AXS", "2026-27", 1)).toThrow(RangeError);
    expect(() => formatDocumentNumber("AXS", "26-27", 0)).toThrow(RangeError);
    expect(() => formatDocumentNumber("AXS", "26-27", 1.5)).toThrow(RangeError);
  });
});

describe("compareDocumentNumbers", () => {
  it("sorts by FY, then numerically, unlike plain string order", () => {
    const numbers = ["AXS/26-27/10000", "AXS/26-27/9999", "AXS/25-26/1104", "AXS/26-27/0002"];
    expect([...numbers].sort()).toEqual(["AXS/25-26/1104", "AXS/26-27/0002", "AXS/26-27/10000", "AXS/26-27/9999"]);
    expect([...numbers].sort(compareDocumentNumbers)).toEqual([
      "AXS/25-26/1104",
      "AXS/26-27/0002",
      "AXS/26-27/9999",
      "AXS/26-27/10000",
    ]);
  });
});

describe("tax settings", () => {
  it("accept a 3-character prefix and refuse longer ones", () => {
    const tax = settingSchemas.tax;
    expect(tax.safeParse(SETTING_DEFAULTS.tax).success).toBe(true);
    const long = tax.safeParse({ ...SETTING_DEFAULTS.tax, invoicePrefix: "AXSIN" });
    expect(long.success).toBe(false);
    expect(long.error?.issues[0]?.message).toBe("Use up to 3 characters: A-Z, 0-9 or -.");
    expect(tax.safeParse({ ...SETTING_DEFAULTS.tax, creditNotePrefix: "AXCN" }).success).toBe(false);
  });
});
