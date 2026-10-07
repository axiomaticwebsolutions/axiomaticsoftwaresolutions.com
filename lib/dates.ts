/**
 * Dates are stored in UTC. Everything India-facing (display, financial years, calendar arithmetic,
 * reminder schedules, yearly counters) uses Asia/Kolkata, which is a fixed UTC+05:30 with no DST.
 */

export const IST_OFFSET_MS = 330 * 60 * 1000;
export const DAY_MS = 86_400_000;
export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type IstParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number };

const pad2 = (n: number) => String(n).padStart(2, "0");

export function istParts(d: Date): IstParts {
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth() + 1,
    day: s.getUTCDate(),
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
    second: s.getUTCSeconds(),
    ms: s.getUTCMilliseconds(),
  };
}

export function fromIstParts(p: Pick<IstParts, "year" | "month" | "day"> & Partial<IstParts>): Date {
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0, p.ms ?? 0) - IST_OFFSET_MS);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "15 Sep 2026" (fixed English month abbreviations; ICU would print "Sept"). */
export function formatDateIST(d: Date | null | undefined, fallback = "\u2014"): string {
  if (!d) return fallback;
  const p = istParts(d);
  return `${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}`;
}

/** "15 Sep 2026, 14:05" */
export function formatDateTimeIST(d: Date | null | undefined, fallback = "\u2014"): string {
  if (!d) return fallback;
  const p = istParts(d);
  return `${formatDateIST(d)}, ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** "Sep 2026" */
export function formatMonthYearIST(d: Date): string {
  const p = istParts(d);
  return `${MONTHS_SHORT[p.month - 1]} ${p.year}`;
}

/** Indian financial year (April-March, IST) as used in invoice numbers: "26-27". */
export function fiscalYearLabel(d: Date): string {
  const p = istParts(d);
  const start = p.month >= 4 ? p.year : p.year - 1;
  return `${pad2(start % 100)}-${pad2((start + 1) % 100)}`;
}

export function istCalendarYear(d: Date): number {
  return istParts(d).year;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Adds calendar months in IST, keeping the time of day and clamping to the month end (31 Jan + 1 = 28/29 Feb). */
export function addCalendarMonths(d: Date, months: number): Date {
  const p = istParts(d);
  const total = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return fromIstParts({ ...p, year, month, day: Math.min(p.day, daysInMonth(year, month)) });
}

export function addCalendarYears(d: Date, years: number): Date {
  return addCalendarMonths(d, years * 12);
}

/** Parses "YYYY-MM-DD" (an IST calendar date) or takes a Date, and returns the start of that IST day. */
export function startOfDayIST(d: Date | string): Date {
  const p = typeof d === "string" ? parseIsoDate(d) : istParts(d);
  return fromIstParts({ year: p.year, month: p.month, day: p.day });
}

/** 23:59:59.999 IST of the given IST calendar date. Coupon end dates are stored this way. */
export function endOfDayIST(d: Date | string): Date {
  return new Date(startOfDayIST(d).getTime() + DAY_MS - 1);
}

function parseIsoDate(s: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new RangeError(`Expected YYYY-MM-DD, got "${s}"`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function maxDate(a: Date | null | undefined, b: Date): Date {
  return a && a.getTime() > b.getTime() ? a : b;
}

/** Whole days from `now` until `target`, rounded up (0 when due today or past). */
export function daysUntil(target: Date, now: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / DAY_MS));
}
