import { describe, expect, it } from "vitest";
import { CSV_BOM, csvCell, csvFileName, csvHeaders, csvRow, csvText, isFormulaLike, toCsv, type CsvColumn } from "@/lib/csv";

type Lic = { id: string; product: string; expires: Date | null; devices: number };

const COLUMNS: CsvColumn<Lic>[] = [
  { header: "License", value: (l) => l.id },
  { header: "Product", value: (l) => l.product },
  { header: "Expires", value: (l) => l.expires },
  { header: "Devices used", value: (l) => l.devices },
];

describe("csvCell", () => {
  it("quotes every cell and doubles inner quotes", () => {
    expect(csvCell("plain")).toBe('"plain"');
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line 1\r\nline 2")).toBe('"line 1\r\nline 2"');
    expect(csvCell("")).toBe('""');
  });

  it("writes empty cells for null, undefined, NaN and infinities", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(Number.NaN)).toBe('""');
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe('""');
  });

  it("formats numbers, bigints, booleans and dates", () => {
    expect(csvCell(4128.82)).toBe('"4128.82"');
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(12n)).toBe('"12"');
    expect(csvCell(true)).toBe('"true"');
    expect(csvCell(new Date("2026-11-17T00:00:00.000Z"))).toBe('"2026-11-17T00:00:00.000Z"');
    expect(csvText(new Date("invalid"))).toBe("");
  });

  it("guards text that a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell("+91 98200 00000")).toBe('"\'+91 98200 00000"');
    expect(csvCell("-2+3")).toBe('"\'-2+3"');
    expect(csvCell("@SUM(A1)")).toBe('"\'@SUM(A1)"');
    expect(csvCell("\tcmd")).toBe('"\'\tcmd"');
    expect(csvCell("\rcmd")).toBe('"\'\rcmd"');
    expect(csvCell("\uFF1D1+1")).toBe('"\'\uFF1D1+1"');
  });

  it("leaves plain numbers and ordinary text alone", () => {
    expect(isFormulaLike("-500.00")).toBe(false);
    expect(isFormulaLike("+5")).toBe(false);
    expect(isFormulaLike("-1e3")).toBe(false);
    expect(isFormulaLike("Sharma Medicals")).toBe(false);
    expect(isFormulaLike("a=b")).toBe(false);
    expect(csvCell("-500.00")).toBe('"-500.00"');
  });

  it("can skip the guard", () => {
    expect(csvCell("=1+1", { guardFormulas: false })).toBe('"=1+1"');
  });
});

describe("toCsv", () => {
  const rows: Lic[] = [
    { id: "LIC-24017", product: "Medical Store Billing", expires: new Date("2026-11-17T00:00:00.000Z"), devices: 2 },
    { id: "LIC-23961", product: 'Cheque "Pro" Printing', expires: null, devices: 1 },
  ];

  it("writes a BOM, a header row and CRLF-terminated rows", () => {
    const csv = toCsv(rows, COLUMNS);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines).toEqual([
      '"License","Product","Expires","Devices used"',
      '"LIC-24017","Medical Store Billing","2026-11-17T00:00:00.000Z","2"',
      '"LIC-23961","Cheque ""Pro"" Printing","","1"',
      "",
    ]);
  });

  it("can leave out the BOM and still writes the header for no rows", () => {
    expect(toCsv([], COLUMNS, { bom: false })).toBe('"License","Product","Expires","Devices used"\r\n');
  });

  it("keeps the rupee sign and other UTF-8 text", () => {
    expect(toCsv([{ a: "\u20B94,128.82" }], [{ header: "Total", value: (r) => r.a }], { bom: false })).toContain(
      "\u20B94,128.82",
    );
  });

  it("guards header cells too", () => {
    expect(csvRow(["=cmd", "ok"])).toBe('"\'=cmd","ok"');
  });
});

describe("csvFileName and csvHeaders", () => {
  it("makes a safe .csv name", () => {
    expect(csvFileName("licenses.csv")).toBe("licenses.csv");
    expect(csvFileName("orders")).toBe("orders.csv");
    expect(csvFileName("../../etc/passwd")).toBe("etc-passwd.csv");
    expect(csvFileName('a"b\r\nc.CSV')).toBe("a-b-c.csv");
    expect(csvFileName("   ")).toBe("export.csv");
  });

  it("builds no-store download headers with an RFC 5987 name", () => {
    const headers = csvHeaders("activity-log.csv");
    expect(headers["Content-Type"]).toBe("text/csv;charset=utf-8");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Content-Disposition"]).toBe(
      "attachment; filename=\"activity-log.csv\"; filename*=UTF-8''activity-log.csv",
    );
  });
});
