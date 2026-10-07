/** Pure admin catalog helpers: labels, rupee input, content line editor, installer names/keys, release status. */
import { describe, expect, it } from "vitest";
import {
  formatFeatureLines,
  installerExtensionError,
  installerStorageKey,
  paiseToRupeesInput,
  parseBenefitLines,
  parseFeatureLines,
  parseRequirementLines,
  parseRupeesToPaise,
  planDeviceLimitLabel,
  planExpiryBehaviour,
  planPriceLines,
  planTermDetail,
  planTermLabel,
  planTypeBadge,
  planTypeFromFilter,
  planUpdatesLabel,
  readProductContent,
  releaseStatusKey,
  releaseStoragePrefix,
  safeInstallerName,
  shortSha256,
} from "@/lib/admin/catalog/model";
import { isStorageKey } from "@/lib/storage/types";

describe("plan labels (prototype table and drawer copy)", () => {
  const annual = { type: "ANNUAL", interval: "YEAR", trialDays: null, deviceLimit: 3, perUnit: null, maxQty: null, updatesMonths: null, multiDevice: true } as const;
  it("renders type, term, devices and updates", () => {
    expect(planTypeBadge(annual)).toEqual({ label: "Multi-device", tone: "sage" });
    expect(planTypeBadge({ type: "DEVICE_ADDON", multiDevice: false })).toEqual({ label: "Add-on", tone: "slate" });
    expect(planTermLabel(annual)).toBe("Per year");
    expect(planTermLabel({ type: "TRIAL", interval: null, trialDays: 15 })).toBe("15 days");
    expect(planTermLabel({ type: "ONE_TIME", interval: null, trialDays: null })).toBe("Perpetual");
    expect(planTermDetail({ type: "SUBSCRIPTION", interval: "MONTH", trialDays: null })).toBe("1 month");
    expect(planDeviceLimitLabel({ perUnit: "terminal", maxQty: 10, deviceLimit: null })).toBe("Per terminal (max 10)");
    expect(planDeviceLimitLabel({ perUnit: null, maxQty: null, deviceLimit: null })).toBe("Attaches to license");
    expect(planUpdatesLabel({ type: "MAINTENANCE", updatesMonths: null })).toBe("+12 months");
    expect(planUpdatesLabel({ type: "ONE_TIME", updatesMonths: 12 })).toBe("12 months");
    expect(planUpdatesLabel(annual)).toBe("During term");
    expect(planExpiryBehaviour("ONE_TIME")).toBe("Keeps working; updates stop");
    expect(planTypeFromFilter("one_time")).toBe("ONE_TIME");
    expect(planTypeFromFilter("nope")).toBeNull();
  });

  it("prices excl. and incl. GST", () => {
    expect(planPriceLines(0, 18)).toEqual({ price: "Free", inclGst: null });
    expect(planPriceLines(499_900, 18)).toEqual({ price: "\u20B94,999", inclGst: "incl. GST \u20B95,898.82" });
  });
});

describe("rupee input", () => {
  it("parses rupees to exact paise and back", () => {
    expect(parseRupeesToPaise("4,999")).toBe(499_900);
    expect(parseRupeesToPaise("\u20B9 4999.5")).toBe(499_950);
    expect(parseRupeesToPaise("0.07")).toBe(7);
    expect(parseRupeesToPaise("-5")).toBeNull();
    expect(parseRupeesToPaise("12.345")).toBeNull();
    expect(parseRupeesToPaise("abc")).toBeNull();
    expect(paiseToRupeesInput(499_900)).toBe("4999");
    expect(paiseToRupeesInput(499_950)).toBe("4999.50");
  });
});

describe("content line editor", () => {
  it("round-trips features and reports malformed lines", () => {
    const parsed = parseFeatureLines("receipt_long | GST billing | Bills | with pipes\n\n bad line \nsearch | Search |  Fast  ");
    expect(parsed.items).toEqual([
      { icon: "receipt_long", title: "GST billing", body: "Bills | with pipes" },
      { icon: "search", title: "Search", body: "Fast" },
    ]);
    expect(parsed.issues).toEqual([{ line: 3, message: "Line 3: use icon | title | description." }]);
    expect(parseFeatureLines(formatFeatureLines(parsed.items)).items).toEqual(parsed.items);
    expect(parseBenefitLines("Fast | Quick billing").items).toEqual([{ title: "Fast", body: "Quick billing" }]);
    expect(parseRequirementLines("OS").issues).toHaveLength(1);
  });

  it("reads stored content leniently", () => {
    expect(readProductContent(null)).toEqual({ features: [], benefits: [], requirements: [] });
    expect(readProductContent({ features: [{ icon: "x", title: 3 }] }).features).toEqual([{ icon: "x", title: "", body: "" }]);
  });
});

describe("installers", () => {
  it("makes safe download names and storage keys", () => {
    expect(safeInstallerName("C:\\Builds\\Medical Store 4.2.1 (x64).EXE")).toBe("Medical-Store-4.2.1-x64.exe");
    expect(safeInstallerName("../../etc/passwd")).toBe("passwd");
    expect(safeInstallerName("???.apk")).toBe("installer.apk");
    expect(releaseStoragePrefix("medical-billing", "4.2.1-beta.1")).toBe("releases/medical-billing/4.2.1-beta.1/");
    const key = installerStorageKey("medical-billing", "4.2.1", "Ab_9", "setup.exe");
    expect(key).toBe("releases/medical-billing/4.2.1/Ab_9/setup.exe");
    expect(isStorageKey(key)).toBe(true);
  });

  it("checks extensions per platform", () => {
    expect(installerExtensionError("windows", "setup.MSI")).toBeNull();
    expect(installerExtensionError("android", "app.exe")).toBe("Android installers are .apk files.");
    expect(installerExtensionError("macos", "a.exe")).toBe("macOS installers are .dmg, .pkg or .zip files.");
    expect(shortSha256("8bb3f33bfc71aa00")).toBe("8bb3f33bfc71\u2026");
  });

  it("derives the release list status", () => {
    expect(releaseStatusKey("PUBLISHED", true)).toBe("latest");
    expect(releaseStatusKey("PUBLISHED", false)).toBe("published");
    expect(releaseStatusKey("DRAFT", true)).toBe("draft");
    expect(releaseStatusKey("WITHDRAWN", false)).toBe("withdrawn");
  });
});
