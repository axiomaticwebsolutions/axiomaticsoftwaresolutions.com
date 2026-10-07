/**
 * Date ranges of the admin Overview and Reports (decisions.md Phase 6: 7d / 30d / 90d / 12m in IST). Pure and
 * client-safe.
 *
 * - 7d / 30d: the last N IST calendar days including today (from 00:00 IST N-1 days ago until now), one bucket per day.
 * - 90d: the last 90 IST days in 13 weekly buckets aligned to today (the first bucket is 6 days long), as in the
 *   prototype ("13 weekly for 90d").
 * - 12m: the current IST month and the 11 before it, one bucket per calendar month.
 * - The previous period has the same length and ends the same distance back ("vs previous 30 days" compares
 *   8 Aug-6 Sep until this time of day with 7 Sep-7 Oct until now), so a partly elapsed today is never compared with
 *   a whole day. For 12m it is the same 12 months a year earlier.
 */
import { addCalendarMonths, DAY_MS, formatDateIST, fromIstParts, istParts, MONTHS_SHORT, startOfDayIST } from "@/lib/dates";

export const RANGE_KEYS = ["7d", "30d", "90d", "12m"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];
export const DEFAULT_RANGE: RangeKey = "30d";

export type BucketUnit = "day" | "week" | "month";

export type RangeMeta = {
  /** Segmented control label (prototype). */
  label: string;
  /** "vs previous 30 days". */
  previousLabel: string;
  /** Export scope and audit detail: "Last 30 days". */
  lastLabel: string;
  unit: BucketUnit;
  /** Length in IST days (null for calendar months). */
  days: number | null;
};

export const RANGE_META: Readonly<Record<RangeKey, RangeMeta>> = Object.freeze({
  "7d": { label: "7 days", previousLabel: "previous 7 days", lastLabel: "Last 7 days", unit: "day", days: 7 },
  "30d": { label: "30 days", previousLabel: "previous 30 days", lastLabel: "Last 30 days", unit: "day", days: 30 },
  "90d": { label: "90 days", previousLabel: "previous 90 days", lastLabel: "Last 90 days", unit: "week", days: 90 },
  "12m": { label: "12 months", previousLabel: "previous 12 months", lastLabel: "Last 12 months", unit: "month", days: null },
});

const MONTHS_IN_YEAR_RANGE = 12;
const WEEKS_IN_90D = 13;

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value);
}

/** Lenient like the list queries: anything unknown (or a repeated parameter's first value) falls back to 30 days. */
export function parseRange(value: unknown): RangeKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return isRangeKey(raw) ? raw : DEFAULT_RANGE;
}

export type RangeBucket = {
  /** "2026-10-07" (day), "2026-10-01" (week start) or "2026-10" (month), IST. */
  key: string;
  start: Date;
  /** Exclusive. */
  end: Date;
  /** Axis label: "7 Oct" or "Oct". */
  label: string;
  /** Tooltip label: "7 Oct 2026", "Week of 1 Oct 2026", "Oct 2026". */
  title: string;
};

export type RangeWindow = {
  key: RangeKey;
  /** Inclusive start (00:00 IST). */
  from: Date;
  /** Exclusive end: the request time. */
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  unit: BucketUnit;
  buckets: RangeBucket[];
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** IST calendar day "YYYY-MM-DD". */
export function istDayKey(d: Date): string {
  const p = istParts(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** IST calendar month "YYYY-MM". */
export function istMonthKey(d: Date): string {
  const p = istParts(d);
  return `${p.year}-${pad2(p.month)}`;
}

/** "7 Oct" */
export function shortDayLabel(d: Date): string {
  const p = istParts(d);
  return `${p.day} ${MONTHS_SHORT[p.month - 1]}`;
}

/** "Oct 2026" from a month key "2026-10". */
export function monthKeyLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS_SHORT[(m ?? 1) - 1]} ${y}`;
}

/** Month label; the first month of a window that starts after the 1st says so ("Sep 2026 (from 8 Sep)"). */
export function windowMonthLabel(key: string, windowFrom: Date | null): string {
  const label = monthKeyLabel(key);
  if (!windowFrom || istMonthKey(windowFrom) !== key || istParts(windowFrom).day === 1) return label;
  return `${label} (from ${shortDayLabel(windowFrom)})`;
}

/** 00:00 IST on the first day of the IST month of `d`. */
export function startOfMonthIST(d: Date): Date {
  const p = istParts(d);
  return fromIstParts({ year: p.year, month: p.month, day: 1 });
}

function dayBuckets(from: Date, days: number): RangeBucket[] {
  return Array.from({ length: days }, (_, i) => {
    const start = new Date(from.getTime() + i * DAY_MS);
    return { key: istDayKey(start), start, end: new Date(start.getTime() + DAY_MS), label: shortDayLabel(start), title: formatDateIST(start) };
  });
}

function weekBuckets(from: Date, today: Date): RangeBucket[] {
  const endOfToday = new Date(today.getTime() + DAY_MS);
  return Array.from({ length: WEEKS_IN_90D }, (_, i) => {
    const end = new Date(endOfToday.getTime() - (WEEKS_IN_90D - 1 - i) * 7 * DAY_MS);
    const start = new Date(Math.max(from.getTime(), end.getTime() - 7 * DAY_MS));
    return { key: istDayKey(start), start, end, label: shortDayLabel(start), title: `Week of ${formatDateIST(start)}` };
  });
}

function monthBuckets(from: Date, months: number): RangeBucket[] {
  return Array.from({ length: months }, (_, i) => {
    const start = addCalendarMonths(from, i);
    const key = istMonthKey(start);
    return { key, start, end: addCalendarMonths(from, i + 1), label: MONTHS_SHORT[istParts(start).month - 1] ?? "", title: monthKeyLabel(key) };
  });
}

/** The window, the previous window and the chart buckets of `key` at `now`. */
export function rangeWindow(key: RangeKey, now: Date): RangeWindow {
  const meta = RANGE_META[key];
  if (meta.days === null) {
    const from = addCalendarMonths(startOfMonthIST(now), -(MONTHS_IN_YEAR_RANGE - 1));
    return {
      key,
      from,
      to: now,
      prevFrom: addCalendarMonths(from, -MONTHS_IN_YEAR_RANGE),
      prevTo: addCalendarMonths(now, -MONTHS_IN_YEAR_RANGE),
      unit: meta.unit,
      buckets: monthBuckets(from, MONTHS_IN_YEAR_RANGE),
    };
  }
  const today = startOfDayIST(now);
  const from = new Date(today.getTime() - (meta.days - 1) * DAY_MS);
  const span = meta.days * DAY_MS;
  return {
    key,
    from,
    to: now,
    prevFrom: new Date(from.getTime() - span),
    prevTo: new Date(now.getTime() - span),
    unit: meta.unit,
    buckets: meta.unit === "week" ? weekBuckets(from, today) : dayBuckets(from, meta.days),
  };
}

/** Index of the bucket that holds `at`, or -1 outside the window. */
export function bucketIndex(buckets: readonly RangeBucket[], at: Date): number {
  const t = at.getTime();
  return buckets.findIndex((b) => t >= b.start.getTime() && t < b.end.getTime());
}

/** IST months ("YYYY-MM") from the window's first month to the month of `to`, oldest first. */
export function monthKeysInWindow(window: Pick<RangeWindow, "from" | "to">): string[] {
  const keys: string[] = [];
  const last = istMonthKey(window.to);
  for (let m = startOfMonthIST(window.from); keys.length < 240; m = addCalendarMonths(m, 1)) {
    const key = istMonthKey(m);
    keys.push(key);
    if (key >= last) break;
  }
  return keys;
}

/** Axis ticks (prototype): the first bucket, one third, two thirds, then "Today". */
export function rangeTicks(buckets: readonly RangeBucket[]): string[] {
  const n = buckets.length;
  if (n === 0) return [];
  const at = (i: number) => buckets[Math.min(n - 1, Math.max(0, i))]?.label ?? "";
  return [at(0), at(Math.round(n / 3)), at(Math.round((2 * n) / 3)), "Today"];
}

/** "Last 30 days (8 Sep – 7 Oct 2026)" for audit details and export scopes (the start year only when it differs). */
export function rangeDescription(window: Pick<RangeWindow, "key" | "from" | "to">): string {
  const sameYear = istParts(window.from).year === istParts(window.to).year;
  const start = sameYear ? shortDayLabel(window.from) : formatDateIST(window.from);
  return `${RANGE_META[window.key].lastLabel} (${start} \u2013 ${formatDateIST(window.to)})`;
}

/**
 * Whole-percent change from `previous` to `current` (prototype: Math.round). Null when the previous period had
 * nothing to compare with (the prototype showed 0%, which hid a rise from zero).
 */
export function deltaPercent(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return Math.round(((current - previous) / previous) * 100);
}
