/**
 * POST /api/account/trials { productId } -> 201 { license: { id, productId, productName, productShortName, planName,
 * status: "trial", keyMasked, issuedAt, expiresAt, deviceLimit }, href }: starts the account's free trial of a
 * product. Team permission `trials.start` (Owner, Billing admin, Technical contact), verified email, CSRF + same origin.
 * 404 unknown or unpublished product, 409 trial_used ("You’ve already used the free trial for this product."), 422
 * trial_unavailable, 10 starts / hour per user. The full key is never returned (reveal it on the license page).
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { startPortalTrial } from "@/lib/portal/trials";
import { PORTAL_BODY_MAX_BYTES, startTrialSchema } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "trials.start", mutation: true });
  const { productId } = await parseJsonBody(req, startTrialSchema, { maxBytes: PORTAL_BODY_MAX_BYTES });
  enforce(await hit(db, RATE_LIMITS.trialStart(ctx.user.id)));
  const started = await startPortalTrial({ accountId: ctx.account.id, user: ctx.user, productId }, db);
  return json(started, { status: 201 });
});
