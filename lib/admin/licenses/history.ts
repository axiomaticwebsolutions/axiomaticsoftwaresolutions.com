/**
 * The license drawer's History (prototype `licDetail` History: "action", "{staff} · {reason}", datetime): license
 * events merged with the audit rows about the license. A staff action writes both a LicenseEvent (customer-visible,
 * no reason) and an AuditLog row (with the reason) in one transaction; the History keeps the audit row and drops the
 * matching event, so staff see each action once, with its reason. Pure and client-safe.
 */
import type { AdminLicenseHistoryEntry } from "./model";

export type HistoryEvent = { id: string; type: string; actor: string; detail: string | null; createdAt: Date };
export type HistoryAudit = { id: string; action: string; actorName: string; reason: string | null; detail: string | null; createdAt: Date };

/** LicenseEvent types that staff actions write, and the audit action each pairs with (prefix match). */
export const STAFF_EVENT_AUDIT_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  suspended: "Suspended license",
  reinstated: "Reinstated license",
  extended: "Extended license",
  devices_reset: "Reset devices",
  revoked: "Revoked license",
  deactivated: "Deactivated device",
  issued: "Issued license",
  trial_started: "Issued license",
});

/** An event and its audit row are written in one transaction; allow for clock and commit skew. */
export const PAIR_WINDOW_MS = 60_000;

const DOT = " \u00B7 ";

function joinParts(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(DOT);
}

/**
 * Newest first, at most `limit` rows. `label(type)` names a license event (lib/licensing/account.ts
 * licenseEventLabel on the server).
 */
export function mergeLicenseHistory(
  events: readonly HistoryEvent[],
  audits: readonly HistoryAudit[],
  label: (type: string) => string,
  limit: number,
): AdminLicenseHistoryEntry[] {
  const used = new Set<string>();
  const kept = events.filter((event) => {
    const action = STAFF_EVENT_AUDIT_ACTIONS[event.type];
    if (!action) return true;
    const pair = audits.find(
      (a) =>
        !used.has(a.id) &&
        a.action.startsWith(action) &&
        Math.abs(a.createdAt.getTime() - event.createdAt.getTime()) <= PAIR_WINDOW_MS,
    );
    if (!pair) return true;
    used.add(pair.id);
    return false;
  });
  const rows: { at: Date; entry: AdminLicenseHistoryEntry }[] = [
    ...kept.map((e) => ({
      at: e.createdAt,
      entry: { id: `event:${e.id}`, label: label(e.type), by: joinParts(e.actor, e.detail) || "System", at: e.createdAt.toISOString() },
    })),
    ...audits.map((a) => ({
      at: a.createdAt,
      entry: { id: `audit:${a.id}`, label: a.action, by: joinParts(a.actorName, a.reason ?? a.detail) || "System", at: a.createdAt.toISOString() },
    })),
  ];
  rows.sort((x, y) => y.at.getTime() - x.at.getTime() || (x.entry.id < y.entry.id ? 1 : -1));
  return rows.slice(0, Math.max(0, limit)).map((r) => r.entry);
}
