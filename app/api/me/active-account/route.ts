/**
 * POST /api/me/active-account { accountId } -> 200 { account: { id, legalName }, role }: switches the business the
 * session works in (portal business switcher). The user must be an ACTIVE member of it; anything else (another
 * account, an invitation not yet accepted, an unknown id, a staff user) answers 404. CSRF + same origin.
 */
import { requireAuthWithCsrf } from "@/lib/auth/flows/route-helpers";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { setActiveAccount } from "@/lib/portal/profile";
import { activeAccountSchema, PORTAL_BODY_MAX_BYTES } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await requireAuthWithCsrf(req);
  const { accountId } = await parseJsonBody(req, activeAccountSchema, { maxBytes: PORTAL_BODY_MAX_BYTES });
  return json(await setActiveAccount(auth, accountId, db));
});
