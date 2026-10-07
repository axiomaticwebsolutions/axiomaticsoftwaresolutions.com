/**
 * POST /api/v1/licenses/activate: the desktop/Android app activates a license on this device
 * (docs/api-contracts.md section 6, developer guide docs/activation-api.md).
 *
 * Device API: no session, cookies or CSRF token (lib/auth/csrf.ts exempts /api/v1/licenses/*); the license key is
 * the credential. Header `X-App-Id: <product code>` is required (400 `invalid_app_id`). Body: strict JSON
 * `{ licenseKey, deviceFingerprint, deviceName, os, appVersion }`, at most 4 KB (lib/validation/activation.ts;
 * 415 / 413 / 400 `invalid_json` / 422 `validation_failed`).
 * Rate limits (counted before the key lookup, unknown and malformed keys included): 60 / min per client IP and
 * 10 / min per key hash -> 429 `too_many_attempts` with Retry-After.
 * 200 `{ status: "activated" | "already_active", licenseId, activationToken, plan, expiresAt, updatesUntil,
 * deviceLimit, devicesUsed, offlineGraceDays }`; 404 `invalid_key`; 403 `license_revoked` | `license_suspended` |
 * `license_expired`; 422 `wrong_product`; 409 `activation_limit_reached` with devicesUsed, deviceLimit, manageUrl.
 * Every response is `Cache-Control: no-store` (it carries a credential).
 */
import { clientIp, json, parseJsonBody, route } from "@/lib/http";
import { activateLicense, requireAppId } from "@/lib/licensing/activation";
import { ACTIVATE_MAX_BODY_BYTES, activateRequestSchema } from "@/lib/validation/activation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const appId = requireAppId(req.headers);
  const body = await parseJsonBody(req, activateRequestSchema, { maxBytes: ACTIVATE_MAX_BODY_BYTES });
  return json(await activateLicense(body, { appId, ip: clientIp(req) }));
});
