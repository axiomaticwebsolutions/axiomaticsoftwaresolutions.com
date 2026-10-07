/**
 * Strict request bodies of the admin license routes (decisions: Zod objects are strict; destructive bodies carry
 * `reason` and, for revoke, `confirmId`, validated by lib/admin/destructive.ts so a missing reason answers 422
 * `reason_required`). Pure.
 */
import { z } from "zod";
import { destructiveFields } from "@/lib/admin/destructive";
import { BULK_MAX_LICENSES, EXTEND_MAX_DAYS } from "./model";

/** Same shape as lib/admin/http.ts idParam(): license ids, cuids. */
export const ADMIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const idString = z.string().regex(ADMIN_ID_RE, "Choose a valid record.");

/** suspend, reinstate, reset-devices, revoke, device deactivate. */
export const licenseActionBody = z.strictObject(destructiveFields);

/** extend { days } (1-365; default 30, the prototype's "Extend 30 days"). */
export const extendLicenseBody = z.strictObject({
  ...destructiveFields,
  days: z.int("Enter a whole number of days.").min(1, "Extend by at least 1 day.").max(EXTEND_MAX_DAYS, `Extend by at most ${EXTEND_MAX_DAYS} days.`).optional(),
});

/** Manual issue { accountId, planId, quantity?, reason } (api-contracts: POST /api/admin/licenses). */
export const manualIssueBody = z.strictObject({
  ...destructiveFields,
  accountId: z.string().regex(ADMIN_ID_RE, "Choose a customer account."),
  planId: z.string().regex(ADMIN_ID_RE, "Choose a plan."),
  quantity: z.int("Enter a whole number.").min(1).max(100).optional(),
});

/** Bulk bar: { action, ids, days?, reason }. */
export const bulkLicenseBody = z.strictObject({
  ...destructiveFields,
  action: z.enum(["extend", "suspend"]),
  ids: z.array(idString).min(1, "Select at least one license.").max(BULK_MAX_LICENSES, `Select at most ${BULK_MAX_LICENSES} licenses.`),
  days: z.int().min(1).max(EXTEND_MAX_DAYS).optional(),
});
