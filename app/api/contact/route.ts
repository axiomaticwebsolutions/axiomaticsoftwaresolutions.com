/**
 * POST /api/contact: a contact message or demo request from /contact (components/store/contact/contact-form.tsx), or a
 * launch waitlist sign-up from a COMING_SOON product page (components/store/product/waitlist-form.tsx).
 *
 * 1. CSRF: same-origin check plus the double-submit token bound to the session id, or "anon" when signed out (also
 *    "anon" when the session cannot be resolved, matching GET /api/csrf). 403 `csrf_failed`.
 * 2. Body: strict JSON (lib/validation/lead.ts), at most 16 KB. 422 `validation_failed` with field errors. A demo's
 *    product must be a PUBLISHED product with demo requests enabled, or "not-sure"; a waitlist sign-up's product must
 *    be a COMING_SOON product.
 * 3. Honeypot: a filled "website" field gets a 200 with a decoy reference (waitlist: the usual { ok: true }); nothing is
 *    stored or rate-limited.
 * 4. Rate limit: 5 requests per hour per client IP (RATE_LIMITS.contactIp), shared by all three kinds. 429 with
 *    Retry-After.
 * 5. Stores the Lead (id DEMO-1001 / MSG-1001 / WAIT-1001 from Counter "lead") with the IP prefix and source and, in the
 *    same transaction, enqueues the acknowledgement to the visitor (not for waitlist sign-ups) and the notice to
 *    settings business.salesEmail (lib/leads.ts, outbox). After commit it kicks the email dispatch and returns 200
 *    { reference }. A waitlist sign-up answers 200 { ok: true } whether it was new or the same email had already
 *    signed up for that product (no second lead, no emails), so the response never reveals who is on a waitlist.
 *    Logs carry the reference only, never the person's details.
 * When the database is unavailable: 503 `unavailable`, asking the visitor to email sales instead.
 */
import { assertCsrf, ANON_CSRF_BINDING, csrfBinding } from "@/lib/auth/csrf";
import { getCurrentAuth } from "@/lib/auth/guards";
import { hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { SETTING_DEFAULTS } from "@/lib/config";
import { db } from "@/lib/db";
import { kickEmailDispatch } from "@/lib/email";
import { getEnv } from "@/lib/env";
import { ApiError, clientIp, errors, ipPrefix, json, parseJsonBody, route } from "@/lib/http";
import { createLead, createWaitlistLead, decoyLeadId } from "@/lib/leads";
import { log } from "@/lib/log";
import { getComingSoonProducts, getStoreProducts, getStoreSettings } from "@/lib/storefront/data";
import { createLeadRequestSchema } from "@/lib/validation/lead";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The longest valid body is about 5 KB (2,000-character message, multi-byte characters); leave room. */
const MAX_BODY_BYTES = 16 * 1024;

async function csrfBindingForRequest(): Promise<string> {
  try {
    const auth = await getCurrentAuth();
    return csrfBinding(auth?.session.id);
  } catch (error) {
    log.warn("contact_session_unavailable", { error });
    return ANON_CSRF_BINDING;
  }
}

async function salesEmail(): Promise<string> {
  try {
    return (await getStoreSettings()).business.salesEmail;
  } catch {
    return SETTING_DEFAULTS.business.salesEmail;
  }
}

/**
 * Name and code of a storage error, never its message: Prisma messages can echo the query arguments (the
 * visitor’s name, email and message).
 */
function errorSummary(error: unknown): { name: string; errorCode?: string } {
  if (!(error instanceof Error)) return { name: typeof error };
  const code = (error as { code?: unknown }).code;
  // "errorCode": the logger redacts any field named like "code".
  return typeof code === "string" ? { name: error.name, errorCode: code } : { name: error.name };
}

function unavailable(email: string): ApiError {
  return new ApiError(503, "unavailable", `We couldn’t send your request. Email us at ${email} instead.`);
}

function rateLimitedMessage(retryAfterSec: number, email: string): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  const wait = minutes === 1 ? "a minute" : `${minutes} minutes`;
  return `You’ve sent several requests in a short time. Try again in ${wait}, or email us at ${email}.`;
}

export const POST = route(async (req) => {
  const env = getEnv();
  assertCsrf(req, { binding: await csrfBindingForRequest(), secret: env.CSRF_SECRET, appUrl: env.APP_URL });

  const email = await salesEmail();
  let demoProductIds: string[];
  let waitlistProductIds: string[];
  let productNames: Map<string, string>;
  try {
    const [products, comingSoon] = await Promise.all([getStoreProducts(), getComingSoonProducts()]);
    demoProductIds = products.filter((p) => p.demoEnabled).map((p) => p.id);
    waitlistProductIds = comingSoon.map((p) => p.id);
    productNames = new Map([...products, ...comingSoon].map((p) => [p.id, p.name]));
  } catch (error) {
    log.error("contact_catalog_unavailable", { error: errorSummary(error) });
    throw unavailable(email);
  }

  const { lead, honeypot } = await parseJsonBody(req, createLeadRequestSchema({ demoProductIds, waitlistProductIds }), {
    maxBytes: MAX_BODY_BYTES,
  });
  const waitlist = lead.kind === "WAITLIST";

  if (honeypot) {
    log.info("lead_honeypot", { kind: lead.kind });
    return json(waitlist ? { ok: true } : { reference: decoyLeadId(lead.kind) });
  }

  const ip = clientIp(req);
  let created: { id: string };
  let isNew = true;
  try {
    const limit = await hit(db, RATE_LIMITS.contactIp(ip));
    if (!limit.allowed) throw errors.rateLimited(limit.retryAfterSec, rateLimitedMessage(limit.retryAfterSec, email));
    const productName = lead.productId ? (productNames.get(lead.productId) ?? null) : null;
    const input = { ...lead, ipPrefix: ipPrefix(ip), notify: { salesEmail: email, productName } };
    if (waitlist) {
      const result = await db.$transaction((tx) => createWaitlistLead(tx, input));
      created = result.lead;
      isNew = result.created;
    } else {
      created = await db.$transaction((tx) => createLead(tx, input));
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    log.error("lead_store_failed", { kind: lead.kind, error: errorSummary(error) });
    throw unavailable(email);
  }

  if (isNew) {
    kickEmailDispatch();
    log.info("lead_created", { reference: created.id, kind: lead.kind, source: lead.source });
  } else {
    log.info("lead_waitlist_repeat", { reference: created.id });
  }
  // Same answer for a new and a repeated waitlist sign-up: no reference, nothing that tells them apart.
  return json(waitlist ? { ok: true } : { reference: created.id });
});
