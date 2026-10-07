/**
 * Append-only staff/system audit trail, written in the same transaction as the change it records.
 * There is deliberately no update or delete helper. Text fields are masked for license-key-shaped content
 * because staff sometimes paste keys into reasons and details.
 */
import type { StaffRole } from "@/generated/prisma/client";
import type { Tx } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { redactLicenseKeys } from "@/lib/licensing/keys";
import { REASON_REQUIRED_MESSAGE, validateReason } from "@/lib/rbac";

export type AuditRole = "owner" | "admin" | "support" | "finance" | "system";
export type AuditActor = { id: string | null; role: AuditRole; ipPrefix?: string | null };

export type AuditEntry = {
  /** Past-tense label from the admin vocabulary, e.g. "Issued refund", "Revoked license". */
  action: string;
  /** Human-readable target, e.g. "AX-10288" or "Medical Store Billing · Annual license". */
  target: string;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  detail?: string | null;
};

export const SYSTEM_ACTOR: AuditActor = Object.freeze({ id: null, role: "system", ipPrefix: null });

const MAX_TEXT = 1000;

const ROLE_BY_STAFF_ROLE: Record<StaffRole, AuditRole> = {
  OWNER: "owner",
  ADMIN: "admin",
  SUPPORT: "support",
  FINANCE: "finance",
};

/** Audit actor for a signed-in staff user. Throws for non-staff users (customers are never audit actors). */
export function actorFromStaff(user: { id: string; staffRole: StaffRole | null }, ipPrefix?: string | null): AuditActor {
  if (!user.staffRole) throw new Error("actorFromStaff requires a staff user with a role.");
  return { id: user.id, role: ROLE_BY_STAFF_ROLE[user.staffRole], ipPrefix: ipPrefix ?? null };
}

function clean(text: string): string;
function clean(text: string | null | undefined): string | null;
function clean(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const masked = redactLicenseKeys(text).trim();
  return masked.length > MAX_TEXT ? `${masked.slice(0, MAX_TEXT - 1)}…` : masked;
}

/** Inserts exactly one AuditLog row. Call inside the transaction that performs the audited change. */
export async function audit(tx: Tx, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: clean(entry.action),
      target: clean(entry.target),
      targetType: entry.targetType ?? null,
      targetId: clean(entry.targetId),
      reason: clean(entry.reason),
      detail: clean(entry.detail),
      ipPrefix: actor.ipPrefix ?? null,
    },
  });
}

/**
 * Validates the reason destructive admin actions must carry (rules and copy from lib/rbac.ts): at least
 * 4 characters after trimming, else 422 `reason_required` "Add a short reason for the audit log.";
 * over the maximum, 422 `reason_too_long`. The `reason` field is highlighted either way.
 */
export function requireReason(input: unknown): string {
  const result = validateReason(typeof input === "string" ? input : null);
  if (result.ok) return result.reason;
  const code = result.message === REASON_REQUIRED_MESSAGE ? "reason_required" : "reason_too_long";
  throw new ApiError(422, code, result.message, {
    details: { fieldErrors: { reason: [result.message] }, formErrors: [] },
  });
}
