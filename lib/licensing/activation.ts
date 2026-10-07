/**
 * Device activation API services (docs/api-contracts.md section 6, docs/decisions.md "Phase 4 decisions",
 * developer guide docs/activation-api.md). The route handlers in app/api/v1/licenses/* check the X-App-Id header and
 * parse the strict body (lib/validation/activation.ts), then call:
 *
 * - activateLicense(): key -> device slot + EdDSA activation token. Rate limits are counted BEFORE the key lookup
 *   (consume semantics, per client IP then per key hash), so guessing unknown or malformed keys is limited too.
 *   One transaction locks the License row (SELECT ... FOR UPDATE), so concurrent activations can never exceed
 *   `deviceLimit`, then counts active devices, creates the DeviceActivation and writes the `activated` LicenseEvent
 *   (actor "Device") and the account's "Activated device" activity entry. The same fingerprint already active is
 *   200 `already_active` with a fresh token and no extra slot. New fingerprints are also capped per license over a
 *   rolling 30 days (activationChurnLimit(): max(3, 2 x deviceLimit), 429 `activation_churn`), because a device
 *   deactivation is free and every deactivated machine keeps its signed token until `exp`.
 * - validateActivation(): the hot path (scale target in docs/decisions.md). Steady state is one signature check plus
 *   ONE indexed read (the license and its matching active device in a single statement). `lastSeenAt`/`appVersion`
 *   are written at most once per 12 h per device, published releases come from a short in-process cache, and no
 *   LicenseEvent rows are ever written. Tokens up to 30 days past expiry are refreshed. Every token's `exp` (the
 *   app's `nextCheckBefore`) is now + LICENSE_OFFLINE_GRACE_DAYS, but never later than the license end.
 * - deactivateFromDevice(): the device frees its own slot. Not counted toward the customer's yearly self-service
 *   limit (License.selfServiceResets is never touched).
 *
 * Failure order everywhere: REVOKED 403 `license_revoked`, SUSPENDED 403 `license_suspended`, expired 403
 * `license_expired`, then 422 `wrong_product` (X-App-Id differs from the license's product code).
 * Nothing here logs keys, tokens or fingerprints.
 */
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { LicenseStatus, PlanType, ReleaseStatus } from "@/generated/prisma/enums";
import { enforceAttempts, RATE_LIMITS, refund, type RateLimitRule } from "@/lib/auth/rate-limit";
import { safeEqual } from "@/lib/auth/tokens";
import { DAY_MS } from "@/lib/dates";
import { db as defaultDb, type Tx } from "@/lib/db";
import { getEnv, getLicenseKeySecrets } from "@/lib/env";
import { ApiError } from "@/lib/http";
import { log } from "@/lib/log";
import { cleanDeviceText, parseAppId, type ActivateRequest, type DeactivateRequest, type ValidateRequest } from "@/lib/validation/activation";
import {
  ActivationTokenError,
  MAX_ACTIVATION_GRACE_DAYS,
  signActivationToken,
  verifyActivationToken,
  type ActivationClaims,
} from "./activation-token";
import { hashLicenseKey } from "./crypto";
import { latestEligibleRelease, STABLE_CHANNEL } from "./entitlement";
import { isLicenseKeyFormat, normalizeLicenseKey, redactLicenseKeys } from "./keys";
import { isExpired } from "./status";

/** `lastSeenAt` / `appVersion` are written at most once per this interval per device. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** /validate and /deactivate accept tokens up to this many days past `exp`; older ones must re-activate. */
export const EXPIRED_TOKEN_REFRESH_DAYS = MAX_ACTIVATION_GRACE_DAYS;
/** LicenseEvent.actor and AccountActivity.actorName for requests made by the app on a device. */
export const DEVICE_ACTOR = "Device";
/** DeviceActivation.deactivatedBy when the device released its own slot. */
export const DEACTIVATED_BY_DEVICE = "device";
/** Published releases per product are cached in-process this long (latestEligibleVersion). */
export const RELEASE_CACHE_TTL_MS = 60_000;
/** New-device activations per license are counted over this rolling window (activation churn cap). */
export const ACTIVATION_CHURN_WINDOW_DAYS = 30;

/**
 * Activations of new fingerprints allowed per license in ACTIVATION_CHURN_WINDOW_DAYS: max(3, 2 x deviceLimit). Covers
 * setting up every slot plus replacing each computer once a month; re-activating an already active fingerprint
 * (reinstall, lost token) is never counted. Stops one slot from being passed between machines with free device
 * deactivations while each machine keeps running offline on its old token.
 */
export function activationChurnLimit(deviceLimit: number): number {
  return Math.max(3, 2 * deviceLimit);
}

export type ActivationPlan = "annual" | "one_time" | "subscription" | "trial";

export type ActivateResult = {
  status: "activated" | "already_active";
  licenseId: string;
  activationToken: string;
  plan: ActivationPlan;
  expiresAt: string | null;
  updatesUntil: string;
  deviceLimit: number;
  devicesUsed: number;
  offlineGraceDays: number;
};

export type ValidateResult = {
  valid: true;
  status: "active" | "trial";
  expiresAt: string | null;
  updatesUntil: string;
  latestEligibleVersion: string | null;
  nextCheckBefore: string;
  activationToken: string;
};

export type DeactivateResult = { status: "deactivated" | "already_deactivated"; devicesUsed: number };

export type ActivationContext = {
  /** Product code from the X-App-Id header (see requireAppId()). */
  appId: string;
  /** clientIp(req): the trusted client address, or null (rate-limited as "unknown"). */
  ip: string | null;
  now?: Date;
  /** Defaults to the shared Prisma client. */
  db?: PrismaClient;
};

/** Customer-facing copy (the apps may show `message` as is). */
export const ACTIVATION_MESSAGES = {
  invalidAppId: "Send the product code of the app in the X-App-Id header.",
  invalidKey: "This license key isn\u2019t valid. Check the key and try again.",
  revoked: "This license has been revoked. Contact support if you think this is a mistake.",
  suspended: "This license is suspended. Contact support to restore it.",
  expired: "This license has expired. Renew it from your account to keep using the software.",
  trialEnded: "Your free trial has ended. Buy a license to keep using the software.",
  wrongProduct: "This license key is for a different product.",
  invalidToken: "This activation isn\u2019t valid. Activate the software again with your license key.",
  tokenExpired:
    "This computer hasn\u2019t checked its license for too long. Activate the software again with your license key.",
  fingerprintMismatch:
    "This activation belongs to a different computer. Activate the software again with your license key.",
  deviceDeactivated: "This computer was deactivated. Activate it again with your license key to keep using the software.",
  activationChurn: "Too many computers were activated on this license recently. Contact support to activate another.",
} as const;

/** "All 3 device slots are in use." plus the portal hint (Docs prototype troubleshooting copy). */
export function activationLimitMessage(deviceLimit: number): string {
  const lead = deviceLimit === 1 ? "The license\u2019s only device slot is in use." : `All ${deviceLimit} device slots are in use.`;
  return `${lead} Deactivate a computer from your account, or add one.`;
}

/**
 * Error codes after which /validate answers `{ valid: false, reason }` (plus the error envelope): the app must stop
 * trusting its stored activation. Rate limits, malformed requests and server errors are NOT in this set: the app
 * keeps its current token and retries later.
 */
export const VALIDATION_FAILURE_CODES: ReadonlySet<string> = new Set([
  "invalid_token",
  "token_expired",
  "fingerprint_mismatch",
  "device_deactivated",
  "license_revoked",
  "license_suspended",
  "license_expired",
  "wrong_product",
]);

// ---------- Helpers ----------

/** The X-App-Id product code, or 400 `invalid_app_id` when it is missing or not three letters. */
export function requireAppId(headers: Pick<Headers, "get">): string {
  const appId = parseAppId(headers.get("x-app-id"));
  if (!appId) throw new ApiError(400, "invalid_app_id", ACTIVATION_MESSAGES.invalidAppId);
  return appId;
}

/** Contract plan names; a TRIAL license reads "trial" whatever plan it points at. */
export function activationPlan(planType: string, status: string, expiresAt: Date | null): ActivationPlan {
  if (status === LicenseStatus.TRIAL || planType === PlanType.TRIAL) return "trial";
  if (planType === PlanType.ANNUAL) return "annual";
  if (planType === PlanType.SUBSCRIPTION) return "subscription";
  if (planType === PlanType.ONE_TIME) return "one_time";
  // Add-on and maintenance plans are never a license's own plan; fall back on the shape of the terms.
  return expiresAt === null ? "one_time" : "annual";
}

/** Raw SQL timestamps: Date from the driver, or "YYYY-MM-DD HH:MM:SS.mmm" text in UTC (timestamp(3), no zone). */
function toDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const text = value.includes("T") ? value : value.replace(" ", "T");
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

type LicenseState = { status: string; expiresAt: Date | null };

/** The status part of the failure order; wrong_product is checked by the caller right after. */
function assertLicenseUsable(license: LicenseState, now: Date): void {
  if (license.status === LicenseStatus.REVOKED) throw new ApiError(403, "license_revoked", ACTIVATION_MESSAGES.revoked);
  if (license.status === LicenseStatus.SUSPENDED) throw new ApiError(403, "license_suspended", ACTIVATION_MESSAGES.suspended);
  if (isExpired(license, now)) {
    const message = license.status === LicenseStatus.TRIAL ? ACTIVATION_MESSAGES.trialEnded : ACTIVATION_MESSAGES.expired;
    throw new ApiError(403, "license_expired", message, { details: { expiresAt: iso(license.expiresAt) } });
  }
}

function assertProduct(productCode: string, appId: string): void {
  if (productCode !== appId) throw new ApiError(422, "wrong_product", ACTIVATION_MESSAGES.wrongProduct);
}

const invalidToken = () => new ApiError(401, "invalid_token", ACTIVATION_MESSAGES.invalidToken);

/** Signature, issuer, audience and claims; tokens up to EXPIRED_TOKEN_REFRESH_DAYS past `exp` are accepted. */
async function verifyDeviceToken(token: string, fingerprint: string, now: Date): Promise<ActivationClaims> {
  let claims: ActivationClaims;
  try {
    ({ claims } = await verifyActivationToken(token, { now, allowExpiredForDays: EXPIRED_TOKEN_REFRESH_DAYS }));
  } catch (e) {
    if (e instanceof ActivationTokenError) {
      throw e.code === "expired" ? new ApiError(401, "token_expired", ACTIVATION_MESSAGES.tokenExpired) : invalidToken();
    }
    throw e;
  }
  // The token is bound to the fingerprint that activated: the request must present the same one. `fp` is readable in
  // the token payload (JWT claims are signed, not secret), so this stops accidental reuse rather than theft: a copied
  // token cannot unlock another computer, because the app checks it against its own hardware fingerprint offline, but
  // whoever holds a copy can call /validate or /deactivate for this device. Apps keep the token in protected storage.
  if (!safeEqual(claims.fp, fingerprint)) {
    throw new ApiError(401, "fingerprint_mismatch", ACTIVATION_MESSAGES.fingerprintMismatch);
  }
  return claims;
}

function manageUrl(licenseId: string): string {
  return `${getEnv().APP_URL}/account/licenses/${encodeURIComponent(licenseId)}`;
}

function activityTarget(licenseId: string, deviceName: string): string {
  return `${licenseId} \u00B7 ${deviceName}`.slice(0, 200);
}

const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * The per-license limit of /validate and /deactivate, counted once the token is verified. A request it refuses gives
 * back the per-IP slot it already took, so a device looping on a license-limited 429 does not use up the shared
 * per-IP budget of the whole office (docs/activation-api.md: refused requests are not counted).
 */
async function enforceLicenseLimit(client: PrismaClient, licenseRule: RateLimitRule, ipRule: RateLimitRule, now: Date): Promise<void> {
  try {
    await enforceAttempts(client, [licenseRule], now);
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      await refund(client, ipRule, now).catch((refundError: unknown) => {
        log.warn("rate_limit_refund_failed", { errorName: refundError instanceof Error ? refundError.name : typeof refundError });
      });
    }
    throw error;
  }
}

/** 429 `activation_churn` with Retry-After: when the oldest counted activation leaves the window. */
function activationChurnError(recent: readonly { activatedAt: Date }[], limit: number, now: Date): ApiError {
  const windowMs = ACTIVATION_CHURN_WINDOW_DAYS * DAY_MS;
  // `recent` is oldest first; the count drops below the limit once recent[length - limit] leaves the window.
  const freesAt = recent[recent.length - limit]?.activatedAt ?? now;
  const retryAfterSec = Math.max(1, Math.ceil((freesAt.getTime() + windowMs - now.getTime()) / 1000));
  return new ApiError(429, "activation_churn", ACTIVATION_MESSAGES.activationChurn, {
    details: { retryAfterSec },
    headers: { "Retry-After": String(retryAfterSec) },
  });
}

// ---------- Release cache (latestEligibleVersion) ----------

type CachedRelease = { version: string; status: ReleaseStatus; releasedAt: Date | null };
type ReleaseCacheEntry = { expires: number; releases: Promise<CachedRelease[]> };

const RELEASE_CACHE_LIMIT = 512;
const releaseCache = new Map<string, ReleaseCacheEntry>();

/**
 * Published stable releases of a product, cached per process for RELEASE_CACHE_TTL_MS (wall clock), so steady-state
 * validations do not query releases. Concurrent misses share one query; a failed query is not cached.
 */
function publishedReleases(client: PrismaClient, productId: string): Promise<CachedRelease[]> {
  const nowMs = Date.now();
  const hit = releaseCache.get(productId);
  if (hit && hit.expires > nowMs) return hit.releases;
  const releases = client.release.findMany({
    where: { productId, status: ReleaseStatus.PUBLISHED, channel: STABLE_CHANNEL },
    select: { version: true, status: true, releasedAt: true },
  });
  if (releaseCache.size >= RELEASE_CACHE_LIMIT) releaseCache.clear();
  const entry: ReleaseCacheEntry = { expires: nowMs + RELEASE_CACHE_TTL_MS, releases };
  releaseCache.set(productId, entry);
  releases.catch(() => {
    if (releaseCache.get(productId) === entry) releaseCache.delete(productId);
  });
  return releases;
}

/** Drops cached releases (tests; admin release publishing may call it on the same instance). */
export function clearReleaseCache(): void {
  releaseCache.clear();
}

// ---------- Activate ----------

type LockedLicenseRow = {
  id: string;
  accountId: string | null;
  status: string;
  expiresAt: Date | string | null;
  updatesUntil: Date | string;
  deviceLimit: number;
  productCode: string;
  planType: string;
};

async function lockLicenseByKeyHash(tx: Tx, keyHash: string) {
  const rows = await tx.$queryRaw<LockedLicenseRow[]>`
    SELECT l."id", l."accountId", l."status"::text AS "status", l."expiresAt", l."updatesUntil", l."deviceLimit",
           p."code" AS "productCode", pl."type"::text AS "planType"
    FROM "License" l
    JOIN "Product" p ON p."id" = l."productId"
    JOIN "Plan" pl ON pl."id" = l."planId"
    WHERE l."keyHash" = ${keyHash}
    FOR UPDATE OF l`;
  const row = rows[0];
  if (!row) return null;
  return { ...row, deviceLimit: Number(row.deviceLimit), expiresAt: toNullableDate(row.expiresAt), updatesUntil: toDate(row.updatesUntil) };
}

/**
 * POST /activate. Throws ApiError: 429 `too_many_attempts`, 404 `invalid_key`, 403 `license_revoked` |
 * `license_suspended` | `license_expired`, 422 `wrong_product`, 409 `activation_limit_reached` (with devicesUsed,
 * deviceLimit, manageUrl), 429 `activation_churn` (too many new computers in 30 days; Retry-After).
 */
export async function activateLicense(input: ActivateRequest, ctx: ActivationContext): Promise<ActivateResult> {
  const client = ctx.db ?? defaultDb;
  const now = ctx.now ?? new Date();
  const key = normalizeLicenseKey(input.licenseKey);
  const keyHash = hashLicenseKey(key, getLicenseKeySecrets().pepper);

  // Counted before the lookup, refused attempts not counted: per IP first, so a flood from one address never
  // creates per-key buckets once its own bucket is full.
  await enforceAttempts(client, [RATE_LIMITS.activateIp(ctx.ip), RATE_LIMITS.activateKey(keyHash)], now);
  if (!isLicenseKeyFormat(key)) throw new ApiError(404, "invalid_key", ACTIVATION_MESSAGES.invalidKey);

  const fingerprint = input.deviceFingerprint;
  const name = cleanDeviceText(input.deviceName).slice(0, 80);
  const os = cleanDeviceText(input.os).slice(0, 80);
  const appVersion = input.appVersion;
  const offlineGraceDays = getEnv().LICENSE_OFFLINE_GRACE_DAYS;

  const result = await client.$transaction(async (tx) => {
    const license = await lockLicenseByKeyHash(tx, keyHash);
    if (!license) throw new ApiError(404, "invalid_key", ACTIVATION_MESSAGES.invalidKey);
    assertLicenseUsable(license, now);
    assertProduct(license.productCode, ctx.appId);

    const active = { licenseId: license.id, deactivatedAt: null };
    const existing = await tx.deviceActivation.findFirst({
      where: { ...active, fingerprint },
      orderBy: { activatedAt: "desc" },
      select: { id: true },
    });

    let status: ActivateResult["status"];
    let devicesUsed: number;
    if (existing) {
      // Re-activation of the same computer (reinstall, lost token): no new slot. The name stays as the customer
      // may have renamed the device in the portal.
      await tx.deviceActivation.update({ where: { id: existing.id }, data: { os, appVersion, lastSeenAt: now } });
      status = "already_active";
      devicesUsed = await tx.deviceActivation.count({ where: active });
    } else {
      const used = await tx.deviceActivation.count({ where: active });
      if (used >= license.deviceLimit) {
        throw new ApiError(409, "activation_limit_reached", activationLimitMessage(license.deviceLimit), {
          details: { devicesUsed: used, deviceLimit: license.deviceLimit, manageUrl: manageUrl(license.id) },
        });
      }
      // Churn cap, under the same row lock: activations of new fingerprints in the last 30 days (active or not).
      // The rows come from the licenseId prefix of DeviceActivation_licenseId_fingerprint_idx; a license only gains
      // rows at this rate, so the scan stays small.
      const churnLimit = activationChurnLimit(license.deviceLimit);
      const recent = await tx.deviceActivation.findMany({
        where: { licenseId: license.id, activatedAt: { gt: new Date(now.getTime() - ACTIVATION_CHURN_WINDOW_DAYS * DAY_MS) } },
        orderBy: [{ activatedAt: "asc" }, { id: "asc" }],
        select: { activatedAt: true },
      });
      if (recent.length >= churnLimit) throw activationChurnError(recent, churnLimit, now);
      await tx.deviceActivation.create({
        data: { licenseId: license.id, fingerprint, name, os, appVersion, activatedAt: now, lastSeenAt: now },
      });
      await tx.licenseEvent.create({
        data: { licenseId: license.id, type: "activated", actor: DEVICE_ACTOR, detail: redactLicenseKeys(name), createdAt: now },
      });
      if (license.accountId) {
        await tx.accountActivity.create({
          data: {
            accountId: license.accountId,
            actorName: DEVICE_ACTOR,
            action: "Activated device",
            target: activityTarget(license.id, name),
            kind: "license",
            createdAt: now,
          },
        });
      }
      status = "activated";
      devicesUsed = used + 1;
    }

    // Signed inside the transaction: if signing fails, nothing is committed. Never valid past the license end.
    const { token } = await signActivationToken(
      { lic: license.id, fp: fingerprint, prod: license.productCode },
      { now, notAfter: license.expiresAt },
    );
    return {
      status,
      licenseId: license.id,
      activationToken: token,
      plan: activationPlan(license.planType, license.status, license.expiresAt),
      expiresAt: iso(license.expiresAt),
      updatesUntil: license.updatesUntil.toISOString(),
      deviceLimit: license.deviceLimit,
      devicesUsed,
      offlineGraceDays,
    } satisfies ActivateResult;
  }, TX_OPTIONS);

  log.info("license_activation", { licenseId: result.licenseId, result: result.status, devicesUsed: result.devicesUsed });
  return result;
}

// ---------- Validate (hot path) ----------

type ValidateRow = {
  id: string;
  status: string;
  expiresAt: Date | string | null;
  updatesUntil: Date | string;
  productId: string;
  deviceId: string | null;
  lastSeenAt: Date | string | null;
};

/** The license and its newest active activation for this fingerprint, in one statement (PK + licenseId/fingerprint index). */
async function readLicenseWithDevice(client: PrismaClient, licenseId: string, fingerprint: string) {
  const rows = await client.$queryRaw<ValidateRow[]>`
    SELECT l."id", l."status"::text AS "status", l."expiresAt", l."updatesUntil", l."productId",
           d."id" AS "deviceId", d."lastSeenAt"
    FROM "License" l
    LEFT JOIN LATERAL (
      SELECT da."id", da."lastSeenAt"
      FROM "DeviceActivation" da
      WHERE da."licenseId" = l."id" AND da."fingerprint" = ${fingerprint} AND da."deactivatedAt" IS NULL
      ORDER BY da."activatedAt" DESC
      LIMIT 1
    ) d ON TRUE
    WHERE l."id" = ${licenseId}`;
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    expiresAt: toNullableDate(row.expiresAt),
    updatesUntil: toDate(row.updatesUntil),
    lastSeenAt: toNullableDate(row.lastSeenAt),
  };
}

/** Throttled presence write: at most once per LAST_SEEN_WRITE_INTERVAL_MS per device, atomic across instances. */
async function touchDevice(client: PrismaClient, deviceId: string, appVersion: string, now: Date): Promise<void> {
  const threshold = new Date(now.getTime() - LAST_SEEN_WRITE_INTERVAL_MS);
  try {
    await client.deviceActivation.updateMany({
      where: { id: deviceId, deactivatedAt: null, lastSeenAt: { lte: threshold } },
      data: { lastSeenAt: now, appVersion },
    });
  } catch (error) {
    // Presence is informational; a failed write must not fail a valid license check.
    log.warn("device_last_seen_write_failed", { deviceId, errorName: error instanceof Error ? error.name : typeof error });
  }
}

/**
 * POST /validate. Throws ApiError: 429 `too_many_attempts`, 401 `invalid_token` | `token_expired` |
 * `fingerprint_mismatch`, 403 `license_revoked` | `license_suspended` | `license_expired` | `device_deactivated`,
 * 422 `wrong_product`. On success returns a fresh token whose expiry is `nextCheckBefore` (now + grace days, capped
 * at the license end).
 */
export async function validateActivation(input: ValidateRequest, ctx: ActivationContext): Promise<ValidateResult> {
  const client = ctx.db ?? defaultDb;
  const now = ctx.now ?? new Date();

  // Per IP before the signature check (bounds the CPU a single client can spend), per license after it (the
  // license id is only trusted once the signature is).
  const ipRule = RATE_LIMITS.validateIp(ctx.ip);
  await enforceAttempts(client, [ipRule], now);
  const claims = await verifyDeviceToken(input.activationToken, input.deviceFingerprint, now);
  await enforceLicenseLimit(client, RATE_LIMITS.validateLicense(claims.lic), ipRule, now);

  const license = await readLicenseWithDevice(client, claims.lic, claims.fp);
  if (!license) throw invalidToken();
  assertLicenseUsable(license, now);
  assertProduct(claims.prod, ctx.appId);
  if (!license.deviceId) throw new ApiError(403, "device_deactivated", ACTIVATION_MESSAGES.deviceDeactivated);

  if (!license.lastSeenAt || now.getTime() - license.lastSeenAt.getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
    await touchDevice(client, license.deviceId, input.appVersion, now);
  }

  const releases = await publishedReleases(client, license.productId);
  const eligible = latestEligibleRelease(
    releases,
    { status: license.status as LicenseStatus, expiresAt: license.expiresAt, updatesUntil: license.updatesUntil },
    now,
  );
  // nextCheckBefore = the new token's exp: now + grace, or the license end if sooner (the app must check again then).
  const { token, expiresAt: nextCheckBefore } = await signActivationToken(claims, { now, notAfter: license.expiresAt });

  return {
    valid: true,
    status: license.status === LicenseStatus.TRIAL ? "trial" : "active",
    expiresAt: iso(license.expiresAt),
    updatesUntil: license.updatesUntil.toISOString(),
    latestEligibleVersion: eligible?.version ?? null,
    nextCheckBefore: nextCheckBefore.toISOString(),
    activationToken: token,
  };
}

// ---------- Deactivate (from the device itself) ----------

/**
 * POST /deactivate. Frees the calling device's slot: DeviceActivation.deactivatedAt/deactivatedBy "device", a
 * `deactivated` LicenseEvent (actor "Device") and the account's "Deactivated device" activity entry. Allowed whatever
 * the license status (an uninstall must always be able to release its slot) and never counted toward the yearly
 * self-service limit. Repeating it (a retry after a lost response) answers 200 `already_deactivated`.
 * Throws ApiError: 429 `too_many_attempts`, 401 `invalid_token` | `token_expired` | `fingerprint_mismatch`,
 * 422 `wrong_product`.
 */
export async function deactivateFromDevice(input: DeactivateRequest, ctx: ActivationContext): Promise<DeactivateResult> {
  const client = ctx.db ?? defaultDb;
  const now = ctx.now ?? new Date();

  const ipRule = RATE_LIMITS.deactivateIp(ctx.ip);
  await enforceAttempts(client, [ipRule], now);
  const claims = await verifyDeviceToken(input.activationToken, input.deviceFingerprint, now);
  await enforceLicenseLimit(client, RATE_LIMITS.deactivateLicense(claims.lic), ipRule, now);
  assertProduct(claims.prod, ctx.appId);

  const result = await client.$transaction(async (tx) => {
    // Same lock order as activation (License, then its devices), so the device count below is exact.
    const locked = await tx.$queryRaw<Array<{ id: string; accountId: string | null }>>`
      SELECT "id", "accountId" FROM "License" WHERE "id" = ${claims.lic} FOR UPDATE`;
    const license = locked[0];
    if (!license) throw invalidToken();

    const active = { licenseId: license.id, deactivatedAt: null };
    const devices = await tx.deviceActivation.findMany({
      where: { ...active, fingerprint: claims.fp },
      orderBy: { activatedAt: "asc" },
      select: { id: true, name: true },
    });
    let released = 0;
    for (const device of devices) {
      const { count } = await tx.deviceActivation.updateMany({
        where: { id: device.id, deactivatedAt: null },
        data: { deactivatedAt: now, deactivatedBy: DEACTIVATED_BY_DEVICE },
      });
      if (count !== 1) continue;
      released += 1;
      await tx.licenseEvent.create({
        data: { licenseId: license.id, type: "deactivated", actor: DEVICE_ACTOR, detail: redactLicenseKeys(device.name), createdAt: now },
      });
      if (license.accountId) {
        await tx.accountActivity.create({
          data: {
            accountId: license.accountId,
            actorName: DEVICE_ACTOR,
            action: "Deactivated device",
            target: activityTarget(license.id, device.name),
            kind: "license",
            createdAt: now,
          },
        });
      }
    }
    const devicesUsed = await tx.deviceActivation.count({ where: active });
    return { licenseId: license.id, status: released > 0 ? "deactivated" : "already_deactivated", devicesUsed } as const;
  }, TX_OPTIONS);

  log.info("license_device_deactivation", { licenseId: result.licenseId, result: result.status, devicesUsed: result.devicesUsed });
  return { status: result.status, devicesUsed: result.devicesUsed };
}
