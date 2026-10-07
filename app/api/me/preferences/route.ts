/**
 * GET /api/me/preferences -> 200 { prefs: { renewals, updates, tickets, offers, offersConsentAt } }: the signed-in
 * customer's email preferences (defaults on, on, on, off).
 * PATCH /api/me/preferences { renewals?, updates?, tickets?, offers? } -> 200 { prefs }. Turning offers on records
 * the consent time (DPDP), turning it off records the withdrawal. CSRF + same origin; 120 writes / 10 min per user.
 * 401 signed out, 403 for staff accounts, 422 validation_failed.
 */
import { requireAuthWithCsrf } from "@/lib/auth/flows/route-helpers";
import { requireCustomer } from "@/lib/auth/guards";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, parseJsonBody, route } from "@/lib/http";
import { getEmailPrefs, updateEmailPrefs } from "@/lib/portal/preferences";
import { emailPrefsPatchSchema, PORTAL_BODY_MAX_BYTES } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CUSTOMERS_ONLY = "Sign in with a customer account to continue.";

export const GET = route(async () => {
  const auth = await requireCustomer();
  return json({ prefs: await getEmailPrefs(auth.user.id, db) });
});

export const PATCH = route(async (req) => {
  const auth = await requireAuthWithCsrf(req);
  if (auth.user.kind !== "CUSTOMER") throw errors.forbidden(CUSTOMERS_ONLY);
  const patch = await parseJsonBody(req, emailPrefsPatchSchema, { maxBytes: PORTAL_BODY_MAX_BYTES });
  enforce(await hit(db, RATE_LIMITS.notificationWrites(auth.user.id)));
  return json({ prefs: await updateEmailPrefs(auth.user.id, patch, { client: db }) });
});
