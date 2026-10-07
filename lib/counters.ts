/**
 * Gap-free human ids and document numbers, allocated from the `Counter` table inside the caller's transaction.
 *
 * One atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` both creates a missing counter and increments an
 * existing one. The row stays locked until the caller's transaction ends, so concurrent allocations queue
 * behind it and a rolled-back transaction gives its number back: numbers are gap-free per committed transaction.
 * Keep these calls late in short transactions; the lock serialises every writer of the same key.
 */
import type { Tx } from "@/lib/db";
import { fiscalYearLabel } from "@/lib/dates";
import { log } from "@/lib/log";

export const COUNTER_START = {
  order: 10312,
  license: 24200,
  ticket: 3019,
  invoice: 1,
  creditNote: 1,
} as const;

/** CGST Rules 46(b) and 53(1)(b): invoice and credit note serial numbers have at most 16 characters. */
export const GST_DOCUMENT_NUMBER_MAX_LENGTH = 16;
/**
 * Document prefixes ("AXS", "AXC") are 1-3 characters of A-Z, 0-9 or "-". "AXS/26-27/" uses 10 characters and
 * leaves 6 digits: 999,999 invoices per financial year (a 2-character prefix allows 9,999,999).
 */
export const DOCUMENT_PREFIX_MAX_LENGTH = 3;
export const DOCUMENT_PREFIX_RE = /^[A-Z0-9-]{1,3}$/;
/** Running numbers are zero-padded to at least 4 digits ("AXS/26-27/0001"), as in the prototype. */
const SEQUENCE_MIN_DIGITS = 4;
const FY_LABEL_RE = /^\d{2}-\d{2}$/;
/** Shares of a series' yearly capacity at which allocation logs a warning, so the prefix can be shortened in time. */
const CAPACITY_WARNINGS = [0.8, 0.9, 0.95, 0.99] as const;

/** Thrown instead of returning a document number longer than GST allows. The payment transaction rolls back. */
export class DocumentSeriesExhaustedError extends Error {
  readonly series: string;
  readonly capacity: number;

  constructor(series: string, capacity: number) {
    super(`Document series ${series} is exhausted: numbers above ${capacity} would exceed 16 characters.`);
    this.name = "DocumentSeriesExhaustedError";
    this.series = series;
    this.capacity = capacity;
  }
}

/** Returns the counter's current value and advances it. `start` is the value handed out when the key is new. */
export async function nextCounterValue(tx: Tx, key: string, start: number): Promise<number> {
  if (!Number.isSafeInteger(start) || start < 0) throw new RangeError("Counter start must be a non-negative integer.");
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "Counter" ("key", "next")
    VALUES (${key}, ${start}::int + 1)
    ON CONFLICT ("key") DO UPDATE SET "next" = "Counter"."next" + 1
    RETURNING "next" - 1 AS "value"`;
  const value = rows[0]?.value;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Counter "${key}" returned no value.`);
  return value;
}

/** "AX-10312" */
export async function nextOrderId(tx: Tx): Promise<string> {
  return `AX-${await nextCounterValue(tx, "order", COUNTER_START.order)}`;
}

/** "LIC-24200" */
export async function nextLicenseId(tx: Tx): Promise<string> {
  return `LIC-${await nextCounterValue(tx, "license", COUNTER_START.license)}`;
}

/** "T-3019" */
export async function nextTicketId(tx: Tx): Promise<string> {
  return `T-${await nextCounterValue(tx, "ticket", COUNTER_START.ticket)}`;
}

function assertPrefix(prefix: string): void {
  if (!DOCUMENT_PREFIX_RE.test(prefix)) {
    throw new RangeError("Document prefix must be 1-3 characters of A-Z, 0-9 or '-' (GST numbers are at most 16 characters).");
  }
}

/** Highest running number that keeps `<prefix>/<FY>/<n>` within 16 characters: 999,999 for "AXS". */
export function documentSeriesCapacity(prefix: string): number {
  assertPrefix(prefix);
  const digits = GST_DOCUMENT_NUMBER_MAX_LENGTH - prefix.length - "/26-27/".length;
  return 10 ** digits - 1;
}

/** "AXS/26-27/1181". Throws DocumentSeriesExhaustedError rather than ever returning more than 16 characters. */
export function formatDocumentNumber(prefix: string, fy: string, n: number): string {
  assertPrefix(prefix);
  if (!FY_LABEL_RE.test(fy)) throw new RangeError(`Financial year label must look like "26-27", got "${fy}".`);
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Document running number must be a positive integer, got ${n}.`);
  const number = `${prefix}/${fy}/${String(n).padStart(SEQUENCE_MIN_DIGITS, "0")}`;
  if (number.length > GST_DOCUMENT_NUMBER_MAX_LENGTH) {
    throw new DocumentSeriesExhaustedError(`${prefix}/${fy}`, documentSeriesCapacity(prefix));
  }
  return number;
}

/**
 * Orders document numbers by prefix, financial year, then running number. Running numbers past 9999 grow a digit,
 * so plain string order would put "AXS/26-27/10000" before "AXS/26-27/9999"; sort with this (or by issue date).
 */
export function compareDocumentNumbers(a: string, b: string): number {
  const parse = (value: string) => {
    const m = /^(.*)\/(\d{2}-\d{2})\/(\d+)$/.exec(value);
    return m ? { prefix: m[1] ?? "", fy: m[2] ?? "", n: Number(m[3]) } : { prefix: value, fy: "", n: 0 };
  };
  const x = parse(a);
  const y = parse(b);
  if (x.prefix !== y.prefix) return x.prefix < y.prefix ? -1 : 1;
  if (x.fy !== y.fy) return x.fy < y.fy ? -1 : 1;
  return x.n - y.n;
}

async function nextDocumentNumber(tx: Tx, counterKey: string, start: number, prefix: string, at: Date): Promise<string> {
  assertPrefix(prefix);
  const fy = fiscalYearLabel(at);
  const n = await nextCounterValue(tx, `${counterKey}:${fy}`, start);
  const capacity = documentSeriesCapacity(prefix);
  const series = `${prefix}/${fy}`;
  if (n > capacity) {
    log.error("document_series_exhausted", { series, capacity });
    throw new DocumentSeriesExhaustedError(series, capacity);
  }
  if (CAPACITY_WARNINGS.some((share) => n === Math.floor(capacity * share))) {
    log.warn("document_series_near_capacity", { series, used: n, capacity });
  }
  return formatDocumentNumber(prefix, fy, n);
}

/**
 * Tax invoice number "AXS/26-27/1181": one sequence per Indian financial year (April-March, IST), taken from
 * `paidAt` (never wall-clock time) so retries and reconciliation land in the same year as the payment.
 */
export async function nextInvoiceNumber(tx: Tx, paidAt: Date, prefix = "AXS"): Promise<string> {
  return nextDocumentNumber(tx, "invoice", COUNTER_START.invoice, prefix, paidAt);
}

/** Credit note number "AXC/26-27/0001", its own per-FY sequence keyed "creditnote:<FY>". */
export async function nextCreditNoteNumber(tx: Tx, at: Date, prefix = "AXC"): Promise<string> {
  return nextDocumentNumber(tx, "creditnote", COUNTER_START.creditNote, prefix, at);
}
