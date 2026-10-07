/**
 * POST /api/v1/licenses/deactivate: the app releases this device's slot, e.g. before an uninstall or a move to a
 * new computer (docs/api-contracts.md section 6, developer guide docs/activation-api.md). Not counted toward the
 * customer's yearly self-service deactivation limit.
 *
 * Device API: no session, cookies or CSRF token; the activation token is the credential (accepted up to 30 days
 * past its expiry). Header `X-App-Id` is required (400 `invalid_app_id`). Body: strict JSON
 * `{ activationToken, deviceFingerprint }`, at most 8 KB.
 * Rate limits: 60 / min per client IP (before the signature check) and 30 / min per license -> 429 with Retry-After.
 * 200 `{ status: "deactivated" | "already_deactivated", devicesUsed }`; 401 `invalid_token` | `token_expired` |
 * `fingerprint_mismatch`; 422 `wrong_product`. `Cache-Control: no-store`.
 */
import { clientIp, json, parseJsonBody, route } from "@/lib/http";
import { deactivateFromDevice, requireAppId } from "@/lib/licensing/activation";
import { DEACTIVATE_MAX_BODY_BYTES, deactivateRequestSchema } from "@/lib/validation/activation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const appId = requireAppId(req.headers);
  const body = await parseJsonBody(req, deactivateRequestSchema, { maxBytes: DEACTIVATE_MAX_BODY_BYTES });
  return json(await deactivateFromDevice(body, { appId, ip: clientIp(req) }));
});
