/**
 * GET /api/account/billing -> 200 { details, invoiceContacts, payments, paymentsTruncated, canEdit }: the active
 * business account's billing & tax details, its invoice contacts (ACTIVE Owner and Billing admin members) and the
 * payment history (newest 100). Every team role (`invoices.view`), verified email.
 *
 * PATCH /api/account/billing { legalName?, gstin?, address?, city?, state?, pin? } -> 200 { ...GET body, changed }.
 * Team permission `billing.edit` (Owner, Billing admin), CSRF + same origin. "" or null clears an optional field.
 * 422 validation_failed (GSTIN format, PIN, State / UT, GSTIN registered in another state, empty legal name).
 * Changes apply to future invoices only; a change logs "Updated billing details" (billing). 30 saves / 10 min per user.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { actorLabel } from "@/lib/portal/activity";
import { getBilling, updateBilling } from "@/lib/portal/billing";
import { teamCan } from "@/lib/rbac";
import { billingDetailsSchema, PORTAL_BODY_MAX_BYTES } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "invoices.view" });
  const billing = await getBilling(ctx.account.id, db);
  return json({ ...billing, canEdit: teamCan(ctx.membership.role, "billing.edit") });
});

export const PATCH = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "billing.edit", mutation: true });
  const patch = await parseJsonBody(req, billingDetailsSchema, { maxBytes: PORTAL_BODY_MAX_BYTES });
  enforce(await hit(db, RATE_LIMITS.billingUpdate(ctx.user.id)));
  const { billing, changed } = await updateBilling(
    { accountId: ctx.account.id, actor: { id: ctx.user.id, name: actorLabel(ctx.user) }, patch },
    db,
  );
  return json({ ...billing, canEdit: true, changed });
});
