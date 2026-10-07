# License activation API (v1): guide for app developers

This is the API the Axiomatic desktop (Windows) and Android apps use to activate a license on a device, check it at
start-up and every day, and release the device again. It implements `docs/api-contracts.md` section 6 of the
handoff with the "Phase 4 decisions" in `docs/decisions.md`. Server code: `lib/licensing/activation.ts`,
`lib/validation/activation.ts`, `app/api/v1/licenses/*/route.ts`.

## At a glance

| | |
|---|---|
| Base URL | `https://<site>/api/v1/licenses` (the contract example is `https://api.axiomatic.example/api/v1/licenses`). HTTPS only. |
| Endpoints | `POST /activate`, `POST /validate`, `POST /deactivate` |
| Required headers | `Content-Type: application/json`, `X-App-Id: <product code>` (the 3-letter code the app was built for, e.g. `MED`) |
| Authentication | `/activate`: the license key. `/validate` and `/deactivate`: the activation token. No cookies, no CSRF token, no session. |
| Bodies | JSON objects with exactly the documented fields (unknown fields are refused). `/activate` at most 4 KB, the others 8 KB. |
| Times | ISO 8601 in UTC, e.g. `2026-11-16T00:00:00.000Z`. `expiresAt: null` means perpetual (one-time license). |
| Caching | Every response is `Cache-Control: no-store`. Never cache responses in a shared cache or proxy. |

Concepts:
- **License key**: `MED-7Q4K-9XTP-W2HD-K8NM`. The customer types or pastes it once. The server accepts any case, spaces
  and missing dashes. Send it only to `/activate`; never log it.
- **Device fingerprint**: 64 lower-case hex characters, the SHA-256 of stable hardware identifiers computed on the
  device (see [Device fingerprint](#device-fingerprint)). The server lower-cases what you send.
- **Device slot**: each license allows `deviceLimit` active devices. An activation uses one slot; the same fingerprint
  never uses a second one.
- **Activation token**: an EdDSA (Ed25519) signed JWT that proves this device was activated. Keep it in protected
  storage. The app verifies it offline with the embedded public key and swaps it for a fresh one at every successful
  `/validate`. Its expiry is the offline grace period (7 days), or the license end if that comes sooner. Anyone
  holding a copy can use it against this API for this device, so keep it as secret as the key.

## Errors, status codes and app behaviour

Every error has the same envelope. Some codes add fields next to `code` and `message`; `/validate` adds `valid` and
`reason` for definitive failures (see [POST /validate](#post-validate)).

```json
{ "error": { "code": "activation_limit_reached", "message": "All 3 device slots are in use. Deactivate a computer from your account, or add one." } }
```

`message` is customer-facing copy that the app may show as is. Branch on `code`, never on `message`.

| Status | `code` | Endpoints | What the app should do |
|---|---|---|---|
| 400 | `invalid_app_id` | all | Bug: send `X-App-Id` with the product code. |
| 400 | `invalid_json` | all | Bug: the body is not valid JSON. |
| 401 | `invalid_token` | validate, deactivate | Delete the stored token; activate again with the license key. |
| 401 | `token_expired` | validate, deactivate | The token expired more than 30 days ago. Delete it; activate again with the key. |
| 401 | `fingerprint_mismatch` | validate, deactivate | The token belongs to another computer (or the hardware changed). Delete it; activate again. |
| 403 | `device_deactivated` | validate | The customer (or support) removed this computer, or a renewal for fewer computers released its slot. Delete the token; offer to activate again. |
| 403 | `license_revoked` | activate, validate | Stop. Show the message (the license was refunded or revoked). |
| 403 | `license_suspended` | activate, validate | Stop. Show the message (support can restore it). |
| 403 | `license_expired` | activate, validate | Show the renewal message; `error.expiresAt` holds the end date. Apply the product's expiry policy (e.g. read-only mode so data can still be exported). |
| 404 | `invalid_key` | activate | The key is unknown or malformed. Ask the customer to check it. |
| 409 | `activation_limit_reached` | activate | All slots are used. Show the message and `error.manageUrl`. |
| 429 | `activation_churn` | activate | Too many new computers were activated on this license in the last 30 days. Show the message (it asks the customer to contact support). Do not retry automatically: `Retry-After` can be days. |
| 413 | `payload_too_large` | all | Bug: body over the limit. |
| 415 | `unsupported_media_type` | all | Bug: send `Content-Type: application/json`. |
| 422 | `validation_failed` | all | Bug or bad input: `error.fieldErrors` lists the fields, e.g. `{ "deviceName": ["Enter a name for this computer (up to 80 characters)."] }`. Unknown fields are reported as `"Unknown field."`. |
| 422 | `wrong_product` | all | The key or token belongs to another product (`X-App-Id` differs). Show the message. |
| 429 | `too_many_attempts` | all | Wait `Retry-After` seconds (also in `error.retryAfterSec`), then retry. Keep using the stored token meanwhile. |
| 503 | `unavailable` | all | The server is overloaded or its database is briefly unreachable. Wait `Retry-After` (also `error.retryAfterSec`), then retry with backoff; keep using the stored token. |
| 500 / 502 / 504 | `internal_error` or none | all | Temporary. Retry with backoff; keep using the stored token. |

Failure order: a revoked, suspended or expired license is reported before `wrong_product`. Unknown and malformed keys
get the same 404, so keys cannot be probed.

### Rate limits

| Endpoint | Per client IP | Per license |
|---|---|---|
| `/activate` | 60 / minute | 10 / minute per key (unknown and malformed keys count too) |
| `/validate` | 60 / minute | 30 / minute |
| `/deactivate` | 60 / minute | 30 / minute |

Over a limit the answer is `429 too_many_attempts` with a `Retry-After` header (seconds) and `error.retryAfterSec`.
Refused requests are not counted against any limit (a request the per-license limit refuses also gives back its
per-IP slot), so waiting `Retry-After` is always enough. Many computers behind one office router
share the per-IP budget: spread scheduled checks with jitter (see [Retry and backoff](#retry-and-backoff)).

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Cache-Control: no-store
Content-Type: application/json

{ "error": { "code": "too_many_attempts", "message": "Too many attempts. Try again in a minute.", "retryAfterSec": 42 } }
```

## POST /activate

Links this device to the license. Call it when the customer enters a key, and again (with the stored key) when the
server says the token or device is no longer valid.

```http
POST /api/v1/licenses/activate
Content-Type: application/json
X-App-Id: MED

{
  "licenseKey": "MED-7Q4K-9XTP-W2HD-K8NM",
  "deviceFingerprint": "3f1c9a0e5b7d2c4e6f8a1b3d5c7e9f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e",
  "deviceName": "Billing counter PC",
  "os": "Windows 11 Pro",
  "appVersion": "4.2.1"
}
```

| Field | Rules |
|---|---|
| `licenseKey` | String, up to 64 characters. Any case; spaces and dashes optional. |
| `deviceFingerprint` | 64 hex characters (SHA-256). |
| `deviceName` | 1-80 characters after clean-up: control characters become spaces, invisible formatting characters are removed, runs of spaces collapse, ends are trimmed. Suggest the computer name and let the customer change it ("Counter PC"). |
| `os` | 1-80 characters, same clean-up, e.g. `Windows 11 Pro 23H2`, `Android 14`. |
| `appVersion` | Up to 32 characters: 2-4 dot-separated numbers with an optional pre-release and build suffix, e.g. `4.2`, `4.2.1`, `4.2.1.1830`, `4.3.0-beta.2+20261007`. |

**200 activated** (a slot was taken):

```json
{
  "status": "activated",
  "licenseId": "LIC-24017",
  "activationToken": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJsaWMiOiJMSUMtMjQwMTciLC4uLn0.c2lnbmF0dXJl",
  "plan": "annual",
  "expiresAt": "2026-11-16T00:00:00.000Z",
  "updatesUntil": "2026-11-16T00:00:00.000Z",
  "deviceLimit": 3,
  "devicesUsed": 2,
  "offlineGraceDays": 7
}
```

**200 already_active**: the same fingerprint is already active on this license (reinstall, lost token, or a retry
after a lost response). Same body with `"status": "already_active"` and a fresh token; no extra slot is used, so
`/activate` is safe to retry.

- `plan`: `"annual" | "one_time" | "subscription" | "trial"`.
- `expiresAt`: end of the license, `null` for a perpetual (one-time) license. `updatesUntil`: the newest release the
  license covers was published on or before this date.
- `devicesUsed`: active devices after this call, including this one.
- `offlineGraceDays`: how long a token stays valid without a check. The token's `exp` is now + `offlineGraceDays`, or
  the license end (`expiresAt`) if that is sooner.

Errors:

```jsonc
// 404
{ "error": { "code": "invalid_key", "message": "This license key isn’t valid. Check the key and try again." } }
// 403
{ "error": { "code": "license_revoked", "message": "This license has been revoked. Contact support if you think this is a mistake." } }
{ "error": { "code": "license_suspended", "message": "This license is suspended. Contact support to restore it." } }
{ "error": { "code": "license_expired", "message": "This license has expired. Renew it from your account to keep using the software.", "expiresAt": "2026-09-30T18:30:00.000Z" } }
{ "error": { "code": "license_expired", "message": "Your free trial has ended. Buy a license to keep using the software.", "expiresAt": "2026-10-01T06:30:00.000Z" } }
// 422
{ "error": { "code": "wrong_product", "message": "This license key is for a different product." } }
// 409
{
  "error": {
    "code": "activation_limit_reached",
    "message": "All 3 device slots are in use. Deactivate a computer from your account, or add one.",
    "devicesUsed": 3,
    "deviceLimit": 3,
    "manageUrl": "https://<site>/account/licenses/LIC-24017"
  }
}
```

With a one-device license the 409 message reads "The license’s only device slot is in use. Deactivate a computer
from your account, or add one."

New computers per license are limited to max(3, 2 × `deviceLimit`) activations in any 30 days, counting computers that
were deactivated again (a slot freed from the device itself is free, so without this one slot could be passed
between machines that each keep running offline on their last token). Re-activating a computer that is still active
(`already_active`) is never counted. Over the limit:

```jsonc
// 429, Retry-After: seconds until the oldest counted activation is 30 days old
{ "error": { "code": "activation_churn", "message": "Too many computers were activated on this license recently. Contact support to activate another.", "retryAfterSec": 2581200 } }
```

Plus the shared errors: 400, 413, 415, 422 `validation_failed`, 429, 5xx.

## POST /validate

The start-up and daily check. It confirms the license and the device, and returns a fresh token.

```http
POST /api/v1/licenses/validate
Content-Type: application/json
X-App-Id: MED

{ "activationToken": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9...", "deviceFingerprint": "3f1c9a0e...c8d0e", "appVersion": "4.2.1" }
```

`activationToken` is the latest token the device holds (up to 4,096 characters). It is accepted up to **30 days
after its expiry**, so a device that was offline for a while can still refresh it; after that it must activate again
with the key. `appVersion` follows the `/activate` rules; the server records it (with the last-seen time) at most
once every 12 hours.

**200** (valid):

```json
{
  "valid": true,
  "status": "active",
  "expiresAt": "2026-11-16T00:00:00.000Z",
  "updatesUntil": "2026-11-16T00:00:00.000Z",
  "latestEligibleVersion": "4.2.1",
  "nextCheckBefore": "2026-10-14T06:30:00.000Z",
  "activationToken": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..."
}
```

- `status`: `"active"` or `"trial"`. "Expiring soon" is for the app to derive: `expiresAt` within 60 days.
- `latestEligibleVersion`: the newest published stable release this license may install (released on or before
  `updatesUntil`), or `null`. Offer an update when it is newer than the installed version; the customer downloads it
  from the account portal.
- `nextCheckBefore`: the new token's expiry: now + 7 days, or the license end (`expiresAt`) if that is sooner, so an
  app offline at the end of a trial or an annual term stops at the end date. Replace the stored token with
  `activationToken`.

**Definitive failures** carry `valid: false` and `reason` (the same value as `error.code`) next to the usual envelope.
After any of these the app must stop treating the license as valid, even if the token's own `exp` is still in the
future (see [Offline behaviour](#offline-behaviour-and-grace-period) for which failures keep the token):

```jsonc
// 401
{ "valid": false, "reason": "invalid_token", "error": { "code": "invalid_token", "message": "This activation isn’t valid. Activate the software again with your license key." } }
{ "valid": false, "reason": "token_expired", "error": { "code": "token_expired", "message": "This computer hasn’t checked its license for too long. Activate the software again with your license key." } }
{ "valid": false, "reason": "fingerprint_mismatch", "error": { "code": "fingerprint_mismatch", "message": "This activation belongs to a different computer. Activate the software again with your license key." } }
// 403
{ "valid": false, "reason": "device_deactivated", "error": { "code": "device_deactivated", "message": "This computer was deactivated. Activate it again with your license key to keep using the software." } }
{ "valid": false, "reason": "license_revoked", "error": { "code": "license_revoked", "message": "This license has been revoked. Contact support if you think this is a mistake." } }
{ "valid": false, "reason": "license_suspended", "error": { "code": "license_suspended", "message": "This license is suspended. Contact support to restore it." } }
{ "valid": false, "reason": "license_expired", "error": { "code": "license_expired", "message": "This license has expired. Renew it from your account to keep using the software.", "expiresAt": "2026-09-30T18:30:00.000Z" } }
// 422
{ "valid": false, "reason": "wrong_product", "error": { "code": "wrong_product", "message": "This license key is for a different product." } }
```

400, 413, 415, 422 `validation_failed`, 429 and 5xx answers do **not** carry `valid`: they say nothing about the
license. Keep the stored token and retry later. A renewed license works again at the next successful `/validate`.

## POST /deactivate

Releases this device's slot, e.g. from "Deactivate this computer" in the app's settings or before an uninstall.
Deactivations started from the device itself do not count toward the customer's 3 self-service deactivations per
year in the portal. It works whatever the license status, with a token up to 30 days past its expiry.

```http
POST /api/v1/licenses/deactivate
Content-Type: application/json
X-App-Id: MED

{ "activationToken": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9...", "deviceFingerprint": "3f1c9a0e...c8d0e" }
```

**200**:

```json
{ "status": "deactivated", "devicesUsed": 1 }
```

`{ "status": "already_deactivated", "devicesUsed": 1 }` when the device was already deactivated (a retry after a
lost response, or the customer removed it in the portal), so the call is safe to retry. `devicesUsed` counts the
license's remaining active devices. Delete the stored token after either answer.

Errors: 401 `invalid_token` | `token_expired` | `fingerprint_mismatch` (bodies as in `/validate`, without `valid`),
422 `wrong_product`, plus the shared 400, 413, 415, 422, 429 and 5xx. If the token is too old, the customer can still
deactivate the computer from the account portal.

## Offline behaviour and grace period

1. After `/activate` or a successful `/validate`, store `activationToken` (protected storage: DPAPI on Windows, the
   Android Keystore) and keep the license key protected the same way so the app can re-activate without asking.
2. At start-up, verify the stored token offline (next section). The app may run while the signature is valid, `fp`
   and `prod` match this device and app, and the current time is before `exp` (= `nextCheckBefore`). The signed `exp`
   never passes the license end, so it is the only date to trust offline; the `expiresAt` stored from a response is
   unsigned and can be edited.
3. Call `/validate` at start-up and about once a day while running. On success, replace the token. When offline,
   keep running on the stored token until `nextCheckBefore` (7 days after the last successful check, or the license
   end if sooner).
4. After `nextCheckBefore` the app must ask the customer to connect to the internet. The expired token is still
   accepted by `/validate` for 30 more days; after that the app activates again with the stored key (the same
   fingerprint gets `already_active`, so no extra slot is used).
5. A definitive `/validate` failure (`valid: false`) overrides the offline check immediately: stop treating the
   license as valid. For `license_expired` and `license_suspended`, keep the token so a later `/validate` (after a
   renewal or reinstatement) unlocks the app again. For `license_revoked`, delete the token and stop: show the
   message; a revoked license never works again (keep the key only so support can identify it). For
   `invalid_token`, `token_expired`, `fingerprint_mismatch`, `device_deactivated` and `wrong_product`, delete the
   token and offer activation.
6. Clock changes: remember the newest time you have trusted (the token's `iat`, the response `Date` header, the
   latest local time seen) and treat a device clock earlier than that as "check required", so winding the clock back
   cannot extend the grace period.

## Verifying the token offline

The token is a compact JWS (JWT) signed with Ed25519:

| Part | Value |
|---|---|
| Header | `{ "alg": "EdDSA", "typ": "JWT" }` |
| `iss` / `aud` | `"axiomatic"` / `"axiomatic-apps"` |
| `iat`, `exp` | Seconds since 1970 (UTC). `exp - iat` is the offline grace period, or less when the license ends sooner. |
| `lic` | License id, e.g. `"LIC-24017"` |
| `fp` | The device fingerprint it was issued to (readable by anyone who has the token: JWT claims are signed, not secret) |
| `prod` | Product code, e.g. `"MED"` |

Accept a token only when the algorithm is exactly `EdDSA`, the signature verifies with the embedded public key, `iss`
and `aud` match, `exp` is in the future, `fp` equals this device's fingerprint and `prod` equals the app's product
code. Embed the public key (`LICENSE_SIGNING_PUBLIC_KEY`, an SPKI PEM) at build time; it is public and safe to ship.
The private key never leaves the server. The token has no `kid`: rotating the signing key needs an app release that
embeds both keys (accept a signature from either) before the server switches.

TypeScript (Node.js or Electron), with `jose`:

```ts
import { importSPKI, jwtVerify } from "jose";

// Replace with the published public key (SPKI PEM). Never embed the private key.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA<published key>
-----END PUBLIC KEY-----`;

const publicKey = importSPKI(PUBLIC_KEY_PEM, "EdDSA");

export type OfflineActivation = { licenseId: string; expiresAt: Date };

/** Throws when the token is forged, expired, or belongs to another device or product. */
export async function verifyActivationOffline(
  token: string,
  fingerprint: string,
  productCode: string,
  now: Date = new Date(),
): Promise<OfflineActivation> {
  const { payload } = await jwtVerify(token, await publicKey, {
    algorithms: ["EdDSA"],
    issuer: "axiomatic",
    audience: "axiomatic-apps",
    typ: "JWT",
    requiredClaims: ["iat", "exp", "lic", "fp", "prod"],
    currentDate: now,
  });
  if (payload.fp !== fingerprint || payload.prod !== productCode || typeof payload.lic !== "string") {
    throw new Error("This activation belongs to another device or product.");
  }
  return { licenseId: payload.lic, expiresAt: new Date((payload.exp as number) * 1000) };
}
```

C# (.NET desktop app): the .NET base library has no Ed25519 verifier, so use a maintained library such as
`BouncyCastle.Cryptography` (shown) or `NSec.Cryptography`. Verify the signature over the exact ASCII bytes of
`header.payload` as received; never re-serialise the JSON before verifying.

```csharp
using System;
using System.IO;
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.OpenSsl;

public static class ActivationToken
{
    // Replace with the published public key (SPKI PEM). Never embed the private key.
    private const string PublicKeyPem = @"-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA<published key>
-----END PUBLIC KEY-----";

    private static readonly Ed25519PublicKeyParameters PublicKey =
        (Ed25519PublicKeyParameters)new PemReader(new StringReader(PublicKeyPem)).ReadObject();

    public sealed record Activation(string LicenseId, DateTimeOffset ExpiresAt);

    /// Throws when the token is forged, expired, or belongs to another device or product.
    public static Activation Verify(string token, string fingerprint, string productCode, DateTimeOffset now)
    {
        var parts = token.Split('.');
        if (parts.Length != 3) throw new InvalidDataException("Malformed activation token.");

        using (var header = JsonDocument.Parse(Base64UrlDecode(parts[0])))
        {
            if (header.RootElement.GetProperty("alg").GetString() != "EdDSA")
                throw new InvalidDataException("Unexpected token algorithm.");
        }

        var signedBytes = Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]);
        var signature = Base64UrlDecode(parts[2]);
        var verifier = new Ed25519Signer();
        verifier.Init(false, PublicKey);
        verifier.BlockUpdate(signedBytes, 0, signedBytes.Length);
        if (!verifier.VerifySignature(signature)) throw new InvalidDataException("Invalid activation token signature.");

        using var payload = JsonDocument.Parse(Base64UrlDecode(parts[1]));
        var claims = payload.RootElement;
        if (claims.GetProperty("iss").GetString() != "axiomatic" || claims.GetProperty("aud").GetString() != "axiomatic-apps")
            throw new InvalidDataException("Activation token issuer or audience mismatch.");
        var expiresAt = DateTimeOffset.FromUnixTimeSeconds(claims.GetProperty("exp").GetInt64());
        if (expiresAt <= now) throw new InvalidDataException("Activation token expired: a license check is required.");
        if (claims.GetProperty("fp").GetString() != fingerprint || claims.GetProperty("prod").GetString() != productCode)
            throw new InvalidDataException("This activation belongs to another device or product.");
        return new Activation(claims.GetProperty("lic").GetString()!, expiresAt);
    }

    private static byte[] Base64UrlDecode(string value)
    {
        var s = value.Replace('-', '+').Replace('_', '/');
        s = s.PadRight(s.Length + (4 - s.Length % 4) % 4, '=');
        return Convert.FromBase64String(s);
    }
}
```

Android (Kotlin/Java): use Tink (`Ed25519Verify`) or BouncyCastle's `Ed25519Signer` with the same checks. The raw
32-byte public key is the last 32 bytes of the SPKI DER (the PEM body after base64 decoding).

## Device fingerprint

The fingerprint identifies "this installation on this computer" across restarts and reinstalls, without revealing
the hardware. Rules:

- Send `SHA-256` as 64 lower-case hex characters. Never send raw serial numbers, MAC addresses or account names.
- Hash a fixed, versioned prefix with the product code and 2-3 stable identifiers, e.g.
  `"axiomatic-device-v1|MED|" + machineGuid + "|" + boardSerial`. Normalise each part (trim, lower-case) and use an
  empty string for a missing part, always in the same order.
- Use identifiers that survive reboots, app updates and reinstalls of the app: on Windows the `MachineGuid` value under
  `HKLM\SOFTWARE\Microsoft\Cryptography` and the motherboard serial (WMI `Win32_BaseBoard.SerialNumber`); on Android
  `Settings.Secure.ANDROID_ID` (stable per device, user and app signing key since Android 8; it changes after a
  factory reset). Do not use IP addresses, host names, Windows user names, USB network adapters, IMEI or the Android
  serial (restricted).
- Compute it once per start-up and cache it in memory. If a part changes (motherboard replaced, Windows reinstalled),
  the computer counts as new: it needs a free slot, and the customer deactivates the old entry in the portal.
- Cloned virtual machines may share identifiers; include a per-installation random value stored in protected storage
  only if the product must tell clones apart (a reinstall then also counts as a new device).

```csharp
// Windows: SHA-256 over stable identifiers (System.Management for WMI).
static string DeviceFingerprint(string productCode)
{
    var machineGuid = (Microsoft.Win32.Registry.GetValue(
        @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography", "MachineGuid", null) as string) ?? "";
    var boardSerial = "";
    using (var search = new System.Management.ManagementObjectSearcher("SELECT SerialNumber FROM Win32_BaseBoard"))
        foreach (var o in search.Get()) { boardSerial = (o["SerialNumber"] as string) ?? ""; break; }
    var input = $"axiomatic-device-v1|{productCode}|{machineGuid.Trim().ToLowerInvariant()}|{boardSerial.Trim().ToLowerInvariant()}";
    var hash = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(input));
    return Convert.ToHexString(hash).ToLowerInvariant();
}
```

## Retry and backoff

- **Retry only** network failures, timeouts (use about 15 s), `429 too_many_attempts` and `5xx`. Wait the larger of `Retry-After` and
  the backoff: `min(1 hour, 30 s × 2^attempt)` with ±20% random jitter (30 s, 1 min, 2 min, 4 min ...).
- **Do not retry automatically** `400`, `401`, `403`, `404`, `409`, `413`, `415`, `422` or `429 activation_churn`: the
  same request will get the same answer. Act on the code instead (table above).
- `/activate` and `/deactivate` are idempotent for a device: after a lost response, retrying returns
  `already_active` (with a fresh token) or `already_deactivated`. Stop after 3 automatic attempts and show the error.
- Schedule the daily `/validate` at a random point 20-28 hours after the last success, not at a fixed clock time, so
  the computers of one office (sharing one IP budget) do not all check at 9:00. In the last 24 hours before
  `nextCheckBefore`, retry hourly (with jitter) until a check succeeds.
- At start-up, do not block the UI on `/validate` while the stored token is valid offline: verify offline, start, and
  validate in the background.

## Security checklist for apps

- Use HTTPS only and the platform's certificate validation; never disable it for "offline" testing in release builds.
- Never log, print or send the license key anywhere except the `/activate` body. Show it masked (`MED-••••-••••-••••-K8NM`).
- Keep the key and the token in protected storage (DPAPI, Android Keystore), not in plain settings files. Never paste
  either into logs, crash reports or support tickets: the token carries the device fingerprint, so a copy cannot
  unlock another computer (the app checks its own hardware), but it can deactivate this one or refresh its token
  through the API.
- Treat `message` as display text only; branch on `code` / `reason`.
- Embed only the public key. A token from the server is the only way to unlock the app; a token that fails offline
  verification is never accepted, whatever the server said earlier.

## What the server records

- `/activate` creates a device entry (fingerprint, name, OS, app version, activation time), a license event
  "activated" (actor "Device") and, for licenses in a business account, an "Activated device" entry in the account's
  activity log. The customer sees and renames devices in the portal.
- `/validate` updates the device's last-seen time and app version at most once every 12 hours and writes no events.
- When a renewal or upgrade lowers the device limit (a per-terminal renewal for fewer terminals), the computers above
  the new limit that were seen least recently are deactivated ("deactivated" license event, actor "System"); their
  next `/validate` answers `device_deactivated`. Checkout refuses a per-terminal quantity below the active computers.
- `/deactivate` marks the device deactivated by the device, with a "deactivated" license event and a "Deactivated
  device" activity entry. The yearly self-service deactivation counter is not touched.
- Device names and OS strings are cleaned before they are stored; text shaped like a license key is masked. Keys,
  tokens and fingerprints never appear in the server logs.
