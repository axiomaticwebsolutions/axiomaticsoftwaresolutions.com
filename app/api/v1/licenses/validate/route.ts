/**
 * POST /api/v1/licenses/validate: the app's start-up and daily license check (docs/api-contracts.md section 6,
 * developer guide docs/activation-api.md). The hot path at scale: one signature check and one indexed read in steady
 * state, `lastSeenAt` written at most once per 12 h per device, no LicenseEvent rows (lib/licensing/activation.ts).
 *
 * Device API: no session, cookies or CSRF token; the activation token is the credential (refreshed up to 30 days
 * past its expiry). Header `X-App-Id` is required (400 `invalid_app_id`). Body: strict JSON
 * `{ activationToken, deviceFingerprint, appVersion }`, at most 8 KB.
 * Rate limits: 60 / min per client IP (before the signature check) and 30 / min per license -> 429 with Retry-After.
 * 200 `{ valid: true, status, expiresAt, updatesUntil, latestEligibleVersion, nextCheckBefore, activationToken }`.
 * A definitive failure answers `{ valid: false, reason, error: { code, message } }` with 401 `invalid_token` |
 * `token_expired` | `fingerprint_mismatch`, 403 `license_revoked` | `license_suspended` | `license_expired` |
 * `device_deactivated`, or 422 `wrong_product`. Other errors (400, 413, 415, 422 `validation_failed`, 429, 5xx) use
 * the plain error envelope: the app keeps its stored token and retries later. `Cache-Control: no-store`.
 */
import { ApiError, clientIp, json, parseJsonBody, route } from "@/lib/http";
import { requireAppId, validateActivation, VALIDATION_FAILURE_CODES } from "@/lib/licensing/activation";
import { VALIDATE_MAX_BODY_BYTES, validateRequestSchema } from "@/lib/validation/activation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `valid: false` + `reason` (contract) alongside the usual error envelope. */
function invalidResponse(e: ApiError): Response {
  const error: Record<string, unknown> = { ...(e.details ?? {}), code: e.code, message: e.message };
  return json({ valid: false, reason: e.code, error }, { status: e.status, headers: e.headers });
}

export const POST = route(async (req) => {
  const appId = requireAppId(req.headers);
  const body = await parseJsonBody(req, validateRequestSchema, { maxBytes: VALIDATE_MAX_BODY_BYTES });
  try {
    return json(await validateActivation(body, { appId, ip: clientIp(req) }));
  } catch (e) {
    if (e instanceof ApiError && VALIDATION_FAILURE_CODES.has(e.code)) return invalidResponse(e);
    throw e;
  }
});
