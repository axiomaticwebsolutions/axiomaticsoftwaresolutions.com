/** Money is always integer paise. Prices exclude GST unless a name says otherwise. */

export const RUPEE = "\u20B9";
export const DEFAULT_GST_RATE_PCT = 18;

const whole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const exact2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function assertPaise(value: number): void {
  if (!Number.isSafeInteger(value)) throw new TypeError(`Expected an integer amount in paise, got ${value}`);
}

/**
 * Formats paise as Indian rupees, matching the prototype's rupees():
 * whole rupees ("₹4,999") unless there are paise or `exact` is set ("₹5,898.82", "₹4,999.00").
 */
export function formatINR(paise: number, opts: { exact?: boolean } = {}): string {
  assertPaise(paise);
  const abs = Math.abs(paise);
  const body = opts.exact || abs % 100 !== 0 ? exact2.format(abs / 100) : whole.format(abs / 100);
  return `${paise < 0 ? "-" : ""}${RUPEE}${body}`;
}

/** Price including GST, rounded to the paisa (integer arithmetic, no float drift). */
export function withTax(paise: number, ratePct: number = DEFAULT_GST_RATE_PCT): number {
  assertPaise(paise);
  return Math.round((paise * (100 + ratePct)) / 100);
}

/** "4999.00" for CSV exports (no grouping, no symbol). */
export function paiseToDecimalString(paise: number): string {
  assertPaise(paise);
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}
