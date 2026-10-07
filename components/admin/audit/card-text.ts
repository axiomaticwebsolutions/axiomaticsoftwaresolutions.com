import { relativeAgo } from "@/lib/admin/audit/format";
import { auditRoleLabel, type AuditRow } from "@/lib/admin/audit/model";

/**
 * Text of the audit phone card (prototype mobile: title "{actor} · {action}", subtitle "{target} · {rel(at)}", role
 * badge). `now` is the server's time of the page, so the relative time renders the same on the server and in the
 * browser. Pure; unit tested.
 */
export function auditCardText(row: Pick<AuditRow, "actorName" | "action" | "target" | "at" | "actorRole">, now: string) {
  return {
    title: `${row.actorName} \u00B7 ${row.action}`,
    subtitle: `${row.target} \u00B7 ${relativeAgo(row.at, now)}`,
    role: auditRoleLabel(row.actorRole),
  };
}
