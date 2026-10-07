import { DAY_MS } from "@/lib/dates";
import { EXPIRING_DAYS } from "@/lib/licensing/status";

/**
 * Prototype EXPIRES colour: amber when the end date is less than the expiring window (60 days) away, or past, whatever
 * the status (`r.expiresAt - Date.now() < 60*864e5`), so trials and suspended licenses ending soon show it too. Pure.
 */
export function expiresSoon(expiresAt: string, nowMs: number): boolean {
  return Date.parse(expiresAt) - nowMs < EXPIRING_DAYS * DAY_MS;
}
