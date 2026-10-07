/**
 * Admin date formats from the prototype (Admin Console.dc.html `fdt` and `rel`), in IST. Pure and client-safe; callers
 * pass `now` from the server render so server HTML and hydration agree.
 */
import { formatDateIST, istParts, MONTHS_SHORT } from "@/lib/dates";

const MINUTE = 60_000;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "6 Oct, 7:27 pm" (prototype fdt; IST, 12-hour clock). Null reads as an em dash. */
export function formatAdminDateTime(value: Date | string | null | undefined): string {
  if (!value) return "\u2014";
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "\u2014";
  const p = istParts(d);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const minute = String(p.minute).padStart(2, "0");
  return `${p.day} ${MONTHS_SHORT[p.month - 1]}, ${hour12}:${minute} ${p.hour < 12 ? "am" : "pm"}`;
}

/** "6 Oct 2026, 7:27 pm": the full form for drawers, titles and CSV readers. */
export function formatAdminDateTimeLong(value: Date | string | null | undefined): string {
  if (!value) return "\u2014";
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "\u2014";
  const short = formatAdminDateTime(d);
  const comma = short.indexOf(",");
  return `${short.slice(0, comma)} ${istParts(d).year}${short.slice(comma)}`;
}

/** Prototype rel(): "just now", "12m ago", "17h ago", "3d ago", then the date ("15 Sep 2026") after 30 days. */
export function relativeAgo(value: Date | string | null | undefined, now: Date | string): string {
  if (!value) return "\u2014";
  const at = toDate(value);
  const ref = toDate(now);
  if (Number.isNaN(at.getTime()) || Number.isNaN(ref.getTime())) return "\u2014";
  const minutes = (ref.getTime() - at.getTime()) / MINUTE;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  const days = Math.round(minutes / 1440);
  return days < 30 ? `${days}d ago` : formatDateIST(at);
}

/** "2026-10-07": the IST calendar date (export file names, date inputs). */
export function isoDateIST(value: Date | string): string {
  const p = istParts(toDate(value));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
