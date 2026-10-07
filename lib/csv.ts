/**
 * CSV for exports (portal and admin): RFC 4180 output that Excel opens correctly.
 *
 * - Every cell is double-quoted and inner quotes are doubled (the prototypes quote every cell).
 * - Rows end with CRLF (RFC 4180); the file starts with a UTF-8 byte order mark so Excel reads the rupee sign.
 * - Text that a spreadsheet would run as a formula (leading = + - @, tab or carriage return, and their full-width
 *   forms) is prefixed with an apostrophe (OWASP "CSV injection"). Plain numbers such as "-500.00" are left alone:
 *   they cannot be formulas and accountants need them as numbers.
 *
 * Pure and isomorphic: route handlers stream `csvRow()` lines (see `csvHeaders()`), client code calls `toCsv()` and
 * `downloadCsv()`.
 */

export type CsvValue = string | number | bigint | boolean | Date | null | undefined;

export type CsvColumn<T> = {
  /** Header cell text. */
  header: string;
  /** Cell value for a row. Dates are written as ISO 8601 (UTC); format them first for another style. */
  value: (row: T) => CsvValue;
};

export type CsvOptions = {
  /** Prefix the UTF-8 byte order mark (default true; Excel needs it for non-ASCII text such as the rupee sign). */
  bom?: boolean;
  /** Guard text cells against spreadsheet formula injection (default true). */
  guardFormulas?: boolean;
};

export const CSV_BOM = "\uFEFF";
export const CSV_EOL = "\r\n";
export const CSV_MIME = "text/csv;charset=utf-8";

// = + - @ tab CR, and the full-width = + - @ that some spreadsheet locales also evaluate.
const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
// A plain decimal number (optionally signed, optional fraction or exponent) cannot be a formula.
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The text of one cell before quoting. NaN and infinities become empty cells. */
export function csvText(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return Number.isNaN(value.getTime()) ? "" : value.toISOString();
}

/** True when a spreadsheet would treat this text as a formula (and it is not a plain number). */
export function isFormulaLike(text: string): boolean {
  return FORMULA_START.test(text) && !PLAIN_NUMBER.test(text);
}

/** One quoted, escaped cell. */
export function csvCell(value: CsvValue, options: Pick<CsvOptions, "guardFormulas"> = {}): string {
  let text = csvText(value);
  if ((options.guardFormulas ?? true) && typeof value === "string" && isFormulaLike(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** One CSV line without the line ending. */
export function csvRow(values: readonly CsvValue[], options: Pick<CsvOptions, "guardFormulas"> = {}): string {
  return values.map((value) => csvCell(value, options)).join(",");
}

/** A whole CSV document: header row, one row per item, CRLF line endings, BOM by default. */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[], options: CsvOptions = {}): string {
  const lines = [csvRow(columns.map((column) => column.header), options)];
  for (const row of rows) lines.push(csvRow(columns.map((column) => column.value(row)), options));
  return `${options.bom === false ? "" : CSV_BOM}${lines.join(CSV_EOL)}${CSV_EOL}`;
}

/** A safe download file name ending in .csv (path separators, quotes and control characters removed). */
export function csvFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 120);
  const base = cleaned.replace(/\.csv$/i, "") || "export";
  return `${base}.csv`;
}

/** Response headers for a CSV download from a route handler (never cached: exports hold account data). */
export function csvHeaders(fileName: string): Record<string, string> {
  const name = csvFileName(fileName);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  return {
    "Content-Type": CSV_MIME,
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Client only: saves `csv` as a file through a temporary object URL. */
export function downloadCsv(fileName: string, csv: string): void {
  if (typeof document === "undefined") throw new Error("downloadCsv() runs in the browser only");
  const blob = new Blob([csv], { type: CSV_MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = csvFileName(fileName);
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the browser has started the download (Safari needs a tick).
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
