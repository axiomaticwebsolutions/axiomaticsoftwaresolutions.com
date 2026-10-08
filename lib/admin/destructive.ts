/**
 * Destructive admin actions (DESTRUCTIVE_ACTIONS in lib/rbac.ts; decisions.md Phase 6): refund, revoke, suspend,
 * reinstate, extend, reset devices, deactivate a device, manual issue, archive/restore plans, hide/publish products,
 * delete coupons, FAQs, empty categories, draft releases and their installers, staff role changes, (de)activation,
 * revoking staff invitations, marking a customer email verified, creating a set-password link and cancelling an unpaid
 * order (admin records).
 *
 * runDestructive() checks the action's permission, requires a reason (4-500 characters) and, for refund, revoke and
 * coupon delete, the typed id; then runs the change and writes exactly one AuditLog row in ONE transaction, so a
 * failure anywhere leaves neither the change nor the audit row. Errors: 403 for a role without the permission,
 * 422 `reason_required` / `reason_too_long` (fieldErrors.reason) and 422 `confirm_mismatch` (fieldErrors.confirmId).
 *
 * Work that must happen outside the transaction (the payment provider's refund call) runs between
 * validateDestructive() and runDestructive(), so a missing reason never reaches the provider.
 */
import "server-only";
import { z } from "zod";
import type { StaffRole } from "@/generated/prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import {
  can,
  DESTRUCTIVE_ACTIONS,
  REASON_MAX_LENGTH,
  REASON_REQUIRED_MESSAGE,
  roleForbiddenMessage,
  validateReason,
  validateTypedConfirmation,
  type DestructiveActionKey,
} from "@/lib/rbac";

/** Past-tense audit labels (the prototype's audit vocabulary). */
export const DESTRUCTIVE_AUDIT_ACTIONS: Record<DestructiveActionKey, string> = {
  "orders.refund": "Issued refund",
  "licenses.revoke": "Revoked license",
  "licenses.suspend": "Suspended license",
  "licenses.reinstate": "Reinstated license",
  "licenses.extend": "Extended license",
  "licenses.reset_devices": "Reset devices",
  "licenses.deactivate_device": "Deactivated device",
  "licenses.issue_manual": "Issued license",
  "plans.archive": "Archived plan",
  "plans.restore": "Restored plan",
  "products.hide": "Hid product",
  "products.publish": "Published product",
  "categories.delete": "Deleted category",
  "releases.delete": "Deleted release draft",
  "releases.remove_installer": "Removed installer",
  "coupons.delete": "Deleted coupon",
  "faqs.delete": "Deleted FAQ",
  "staff.change_role": "Changed staff role",
  "staff.deactivate": "Deactivated staff",
  "staff.reactivate": "Reactivated staff",
  "staff.revoke_invite": "Revoked staff invitation",
  "customers.verify_email": "Marked email as verified",
  "customers.set_password_link": "Created set-password link",
  "orders.cancel": "Cancelled order",
};

/**
 * Body fields every destructive route accepts; spread them into the route's strict schema:
 * `z.strictObject({ ...destructiveFields, days: z.int() })`. Both are optional here so a missing reason answers
 * 422 `reason_required` from runDestructive() rather than a generic validation error.
 */
export const destructiveFields = {
  reason: z.string().max(REASON_MAX_LENGTH * 4).nullish(),
  confirmId: z.string().max(200).nullish(),
};

/** `{ reason, confirmId }` alone (actions without other input). */
export const destructiveBodySchema = z.strictObject(destructiveFields);

export type DestructiveInput = { reason?: unknown; confirmId?: unknown };

export type DestructiveCheck = {
  staff: { role: StaffRole };
  input: DestructiveInput;
  /** Id the user must type for typed-id actions (order id, license id, coupon code). */
  confirmValue: string;
};

export const CONFIRM_MISMATCH_CODE = "confirm_mismatch";

/**
 * Permission, reason and typed-id checks for `actionKey`. Returns the trimmed reason. Both field errors are reported
 * together when both are wrong (the code names the reason first).
 */
export function validateDestructive(actionKey: DestructiveActionKey, check: DestructiveCheck): { reason: string } {
  const rule = DESTRUCTIVE_ACTIONS[actionKey];
  if (!can(check.staff.role, rule.perm)) throw errors.forbidden(roleForbiddenMessage(check.staff.role));
  const reasonInput = typeof check.input.reason === "string" ? check.input.reason : null;
  const confirmInput = typeof check.input.confirmId === "string" ? check.input.confirmId : null;
  const reasonResult = validateReason(reasonInput);
  const confirmResult = rule.typedId ? validateTypedConfirmation(confirmInput, check.confirmValue) : ({ ok: true } as const);

  if (!reasonResult.ok) {
    const code = reasonResult.message === REASON_REQUIRED_MESSAGE ? "reason_required" : "reason_too_long";
    const fieldErrors: Record<string, string[]> = { reason: [reasonResult.message] };
    if (!confirmResult.ok) fieldErrors.confirmId = [confirmResult.message];
    throw new ApiError(422, code, reasonResult.message, { details: { fieldErrors, formErrors: [] } });
  }
  if (!confirmResult.ok) {
    throw new ApiError(422, CONFIRM_MISMATCH_CODE, confirmResult.message, {
      details: { fieldErrors: { confirmId: [confirmResult.message] }, formErrors: [] },
    });
  }
  return { reason: reasonResult.reason };
}

export type RunDestructiveOptions<T> = {
  staff: { id: string; role: StaffRole };
  actor: AuditActor;
  /** The request body's `reason` and `confirmId`. */
  input: DestructiveInput;
  /** Audit target id (order id, license id, coupon code, staff id...). */
  targetId: string;
  /** Human-readable audit target, e.g. "AX-10288" or "Medical Store Billing · Annual license". */
  target: string;
  /** order | license | plan | product | coupon | faq | staff | ... */
  targetType: string;
  /** Value the user types for typed-id actions (default `targetId`). */
  confirmValue?: string;
  /**
   * Audit action label (default DESTRUCTIVE_AUDIT_ACTIONS[actionKey]), e.g. "Extended license +30 days", or a function
   * of fn's result (a refund of a duplicate payment reads "Refunded duplicate payment").
   */
  action?: string | ((result: T) => string);
  /** Audit detail, or a function of fn's result ("Rs 4,128.82 · 2 licenses revoked"). Never secrets or keys. */
  detail?: string | null | ((result: T) => string | null | undefined);
  /**
   * fn calls a service that writes the single audit row itself (adminResetDevices). runDestructive then writes none;
   * fn must still write exactly one, using `ctx.reason` and `ctx.actor`.
   */
  selfAudited?: boolean;
  transaction?: DestructiveTransactionOptions;
  /** Database client (tests). */
  client?: DestructiveClient;
};

export type DestructiveTransactionOptions = { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number; maxWait?: number };

/** What runDestructive needs from the database client (the Prisma client in the app). */
export type DestructiveClient = { $transaction: <R>(fn: (tx: Tx) => Promise<R>, options?: DestructiveTransactionOptions) => Promise<R> };

export type DestructiveContext = { reason: string; actor: AuditActor };

/**
 * Validates (validateDestructive), then runs `fn` and the audit row in one transaction and returns fn's result.
 * Anything fn throws rolls the whole transaction back (no audit row).
 */
export async function runDestructive<T>(
  actionKey: DestructiveActionKey,
  opts: RunDestructiveOptions<T>,
  fn: (tx: Tx, ctx: DestructiveContext) => Promise<T>,
): Promise<T> {
  const { reason } = validateDestructive(actionKey, {
    staff: opts.staff,
    input: opts.input,
    confirmValue: opts.confirmValue ?? opts.targetId,
  });
  const client = opts.client ?? db;
  return client.$transaction(async (tx) => {
    const result = await fn(tx, { reason, actor: opts.actor });
    if (!opts.selfAudited) {
      const detail = typeof opts.detail === "function" ? opts.detail(result) : opts.detail;
      await audit(tx, opts.actor, {
        action: (typeof opts.action === "function" ? opts.action(result) : opts.action) ?? DESTRUCTIVE_AUDIT_ACTIONS[actionKey],
        target: opts.target,
        targetType: opts.targetType,
        targetId: opts.targetId,
        reason,
        detail: detail ?? null,
      });
    }
    return result;
  }, opts.transaction);
}
