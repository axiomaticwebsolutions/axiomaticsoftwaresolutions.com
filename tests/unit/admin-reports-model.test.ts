/**
 * Reports read model and export catalogue (lib/admin/reports/model.ts) and the download helpers
 * (components/admin/reports/download.ts): exact credit note splits, totals, file names, card and toast copy.
 */
import { describe, expect, it } from "vitest";
import { dispositionFileName, exportMeta } from "@/components/admin/reports/download";
import { RANGE_KEYS } from "@/lib/admin/overview/range";
import { redactLicenseKeys } from "@/lib/licensing/keys";
import {
  addSplit,
  creditNoteCount,
  durationText,
  emptyTotals,
  exportToastText,
  isReportExportKey,
  REPORT_CARD_KEYS,
  REPORT_EXPORT_KEYS,
  REPORT_EXPORTS,
  reportCardMeta,
  reportExportPath,
  reportFileName,
  reportsNote,
  refundSplit,
  splitOverLines,
} from "@/lib/admin/reports/model";

describe("credit note splits", () => {
  it("a full refund reverses the invoice exactly", () => {
    const order = { taxablePaise: 500_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 90_000, totalPaise: 590_000 };
    expect(refundSplit(590_000, order)).toEqual({ taxablePaise: 500_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 90_000 });
  });

  it("a partial refund splits in proportion and always sums to the amount", () => {
    const order = { taxablePaise: 200_000, cgstPaise: 18_000, sgstPaise: 18_000, igstPaise: 0, totalPaise: 236_000 };
    expect(refundSplit(118_000, order)).toEqual({ taxablePaise: 100_000, cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0 });
    const odd = { taxablePaise: 84_746, cgstPaise: 7_627, sgstPaise: 7_627, igstPaise: 0, totalPaise: 100_000 };
    const s = refundSplit(33_333, odd);
    expect(s.taxablePaise + s.cgstPaise + s.sgstPaise + s.igstPaise).toBe(33_333);
  });

  it("caps at the order total and ignores negative amounts", () => {
    const order = { taxablePaise: 1_000, cgstPaise: 90, sgstPaise: 90, igstPaise: 0, totalPaise: 1_180 };
    expect(refundSplit(99_999, order)).toEqual({ taxablePaise: 1_000, cgstPaise: 90, sgstPaise: 90, igstPaise: 0 });
    expect(refundSplit(-5, order)).toEqual({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
  });

  it("splits over order lines by their taxable value", () => {
    expect(splitOverLines(100_000, [400_000, 100_000])).toEqual([80_000, 20_000]);
    expect(splitOverLines(1, [1, 1])).toHaveLength(2);
    expect(splitOverLines(500, [])).toEqual([]);
  });

  it("running totals add tax and value", () => {
    const t = addSplit(addSplit(emptyTotals(), { taxablePaise: 1_000, cgstPaise: 90, sgstPaise: 90, igstPaise: 0 }), {
      taxablePaise: 500,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 90,
    });
    expect(t).toEqual({ taxablePaise: 1_500, cgstPaise: 90, sgstPaise: 90, igstPaise: 90, taxPaise: 270, valuePaise: 1_770 });
  });
});

describe("export catalogue", () => {
  it("keeps the prototype's six cards in order, then the on-page reports", () => {
    expect(REPORT_CARD_KEYS).toEqual(["sales-register", "gst-by-state", "refunds", "license-register", "renewal-forecast", "support-sla"]);
    expect(REPORT_CARD_KEYS.map((k) => REPORT_EXPORTS[k].title)).toEqual([
      "Sales register",
      "GST summary by state",
      "Refunds & credit notes",
      "License register",
      "Renewal forecast",
      "Support SLA",
    ]);
    expect(REPORT_EXPORT_KEYS).toHaveLength(11);
    expect(isReportExportKey("gst-by-month")).toBe(true);
    expect(isReportExportKey("passwords")).toBe(false);
    expect(isReportExportKey(undefined)).toBe(false);
  });

  it("file names, paths, card meta, notes and toasts", () => {
    expect(reportFileName("sales-register", "30d", "2026-10-07")).toBe("sales-register-30d-2026-10-07.csv");
    expect(reportFileName("license-register", "30d", "2026-10-07")).toBe("license-register-all-2026-10-07.csv");
    expect(reportFileName("renewal-forecast", "7d", "2026-10-07")).toBe("renewal-forecast-next90-2026-10-07.csv");
    expect(reportFileName("license-health", "12m", "2026-10-07")).toBe("license-health-2026-10-07.csv");
    expect(reportExportPath("gst-by-month", "7d")).toBe("/api/admin/reports/export.csv?report=gst-by-month&range=7d");
    expect(reportCardMeta("range", "Last 30 days", true)).toBe("CSV \u00B7 Last 30 days \u00B7 sample data");
    expect(reportCardMeta("all", "Last 30 days", false)).toBe("CSV \u00B7 All licenses");
    expect(reportCardMeta("next90", "Last 7 days", false)).toBe("CSV \u00B7 Next 90 days");
    expect(reportsNote("Last 7 days (1 \u2013 7 Oct 2026)", false)).toBe("Last 7 days (1 \u2013 7 Oct 2026) \u00B7 amounts exclude GST unless noted");
    expect(reportsNote("X", true)).toBe("Sample data \u00B7 X \u00B7 amounts exclude GST unless noted");
    expect(exportToastText(1, "a.csv", false)).toBe("Exported 1 row \u00B7 a.csv");
    expect(exportToastText(10_000, "b.csv", true)).toBe("Exported the first 10,000 rows \u00B7 b.csv");
  });

  it("file names and titles never look like license keys to the audit and log redaction", () => {
    for (const key of REPORT_EXPORT_KEYS) {
      expect(redactLicenseKeys(REPORT_EXPORTS[key].title), key).toBe(REPORT_EXPORTS[key].title);
      for (const range of RANGE_KEYS) {
        const name = reportFileName(key, range, "2026-10-07");
        expect(redactLicenseKeys(name), name).toBe(name);
      }
    }
  });

  it("durations and counts", () => {
    expect(durationText(null)).toBe("\u2014");
    expect(durationText(0.4)).toBe("0 min");
    expect(durationText(45)).toBe("45 min");
    expect(durationText(60)).toBe("1 h");
    expect(durationText(200)).toBe("3 h 20 min");
    expect(durationText(1_440)).toBe("1 d");
    expect(durationText(3_120)).toBe("2 d 4 h");
    expect(creditNoteCount(1)).toBe("1 credit note");
    expect(creditNoteCount(2)).toBe("2 credit notes");
  });
});

describe("download helpers", () => {
  it("reads the file name from Content-Disposition, RFC 5987 first", () => {
    expect(dispositionFileName(`attachment; filename="a.csv"; filename*=UTF-8''sales%20register.csv`, "x.csv")).toBe("sales register.csv");
    expect(dispositionFileName(`attachment; filename="gst-by-month-7d.csv"`, "x.csv")).toBe("gst-by-month-7d.csv");
    expect(dispositionFileName(`attachment; filename="../etc/passwd"`, "x.csv")).toBe(".._etc_passwd");
    expect(dispositionFileName(null, "x.csv")).toBe("x.csv");
    expect(dispositionFileName("attachment", "x.csv")).toBe("x.csv");
  });

  it("reads the row count and truncation headers", () => {
    expect(exportMeta(new Headers({ "x-row-count": "12", "x-truncated": "1" }))).toEqual({ rows: 12, truncated: true });
    expect(exportMeta(new Headers({ "x-row-count": "abc" }))).toEqual({ rows: 0, truncated: false });
  });
});
