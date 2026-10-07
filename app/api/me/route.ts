/**
 * GET /api/me -> 200 { user: { id, name, email, kind, emailVerified, staffRole }, account: { id, legalName } | null,
 * role: TeamRole | null } for the signed-in user (account = the session's active business account), 401 otherwise.
 *
 * PATCH /api/me { name?, phone? } -> 200 { user: { id, name, email, phone, emailVerified, twoStepEnabled } }
 * (Security > "Your profile"). name: 1-120 characters, no links or email addresses; phone: an Indian mobile number
 * (stored as 10 digits), "" or null removes it. CSRF + same origin; 30 saves / 10 min per user; no activity entry.
 * 401 signed out, 403 csrf_failed, 422 validation_failed.
 */
import { getMe } from "@/lib/auth/flows/me";
import { requireAuthWithCsrf } from "@/lib/auth/flows/route-helpers";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { updateProfile } from "@/lib/portal/profile";
import { PORTAL_BODY_MAX_BYTES, profilePatchSchema } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const auth = await requireUser();
  return json(await getMe(auth));
});

export const PATCH = route(async (req) => {
  const auth = await requireAuthWithCsrf(req);
  const patch = await parseJsonBody(req, profilePatchSchema, { maxBytes: PORTAL_BODY_MAX_BYTES });
  return json({ user: await updateProfile(auth.user, patch, { client: db }) });
});
