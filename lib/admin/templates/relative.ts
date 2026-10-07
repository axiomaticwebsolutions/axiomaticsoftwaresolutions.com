/** Relative times for admin tables (prototype rel()). Pure and client-safe. */
import { formatDateIST } from "@/lib/dates";

/** "just now", "12m ago", "5h ago", "3d ago", then the IST date ("6 Sep 2026") after 30 days; an em dash for none. */
export function relativeAgo(value: Date | string | null | undefined, now: Date | string): string {
  if (!value) return "\u2014";
  const at = typeof value === "string" ? new Date(value) : value;
  const ref = typeof now === "string" ? new Date(now) : now;
  if (Number.isNaN(at.getTime())) return "\u2014";
  const minutes = Math.max(0, (ref.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : formatDateIST(at);
}
