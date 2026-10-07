/**
 * Activation tokens: EdDSA (Ed25519) JWTs that the desktop and Android apps verify offline with the embedded public
 * key (docs/api-contracts.md section 6). The token lifetime is the offline grace period, capped at the license end: the
 * app keeps working without a network check until `exp`, and /validate swaps an expired-but-recent token for a fresh
 * one.
 *
 * Verification is on the /validate hot path, so imported keys are cached per PEM instead of being parsed per call.
 * Server code only (keys come from lib/env.ts).
 */
import { errors as joseErrors, importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from "jose";
import { DAY_MS } from "@/lib/dates";
import { getEnv } from "@/lib/env";

/** `lic` = License.id, `fp` = device fingerprint (SHA-256 hex from the app), `prod` = Product.code (X-App-Id). */
export type ActivationClaims = { lic: string; fp: string; prod: string };

export type VerifiedActivationToken = { claims: ActivationClaims; expiresAt: Date; expired: boolean };

export type SignActivationTokenOptions = {
  privateKeyPem?: string;
  graceDays?: number;
  now?: Date;
  /**
   * The license end (License.expiresAt): `exp` never passes it, so an app offline at the end of an annual license or a
   * trial stops at the end date instead of up to `graceDays` later. Omit (or null) for perpetual licenses.
   */
  notAfter?: Date | null;
};
export type VerifyActivationTokenOptions = { publicKeyPem?: string; now?: Date; allowExpiredForDays?: number };

export const ACTIVATION_TOKEN_ALG = "EdDSA";
export const ACTIVATION_TOKEN_ISSUER = "axiomatic";
export const ACTIVATION_TOKEN_AUDIENCE = "axiomatic-apps";
export const ACTIVATION_TOKEN_TYPE = "JWT";
/** Upper bound for both the grace period and the expired-token refresh window. */
export const MAX_ACTIVATION_GRACE_DAYS = 30;
/** Generous bound that still stops a hostile client from making the server parse megabytes. */
export const MAX_ACTIVATION_TOKEN_LENGTH = 4096;

const MAX_CLAIM_LENGTH = 128;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

export type ActivationTokenErrorCode = "invalid" | "expired" | "malformed";

/**
 * `invalid`: bad signature, issuer, audience, algorithm or structure. `expired`: past `exp` and outside the allowed
 * refresh window. `malformed`: signature fine but the claims are not an ActivationClaims object. Messages are generic.
 */
export class ActivationTokenError extends Error {
  readonly code: ActivationTokenErrorCode;

  constructor(code: ActivationTokenErrorCode, message: string) {
    super(message);
    this.name = "ActivationTokenError";
    this.code = code;
  }
}

const KEY_CACHE_LIMIT = 16;
const privateKeys = new Map<string, Promise<CryptoKey>>();
const publicKeys = new Map<string, Promise<CryptoKey>>();

function cachedKey(cache: Map<string, Promise<CryptoKey>>, pem: string, load: (pem: string) => Promise<CryptoKey>) {
  let key = cache.get(pem);
  if (!key) {
    if (cache.size >= KEY_CACHE_LIMIT) cache.clear();
    key = load(pem);
    // A PEM that fails to import must not poison the cache for later calls.
    key.catch(() => cache.delete(pem));
    cache.set(pem, key);
  }
  return key;
}

function isClaimString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CLAIM_LENGTH && !CONTROL_CHARS_RE.test(value);
}

function assertClaims(claims: ActivationClaims): void {
  if (!isClaimString(claims.lic) || !isClaimString(claims.fp) || !isClaimString(claims.prod)) {
    throw new RangeError("Activation claims lic, fp and prod must be non-empty strings of at most 128 characters");
  }
}

function assertDays(days: number, min: number, label: string): void {
  if (!Number.isInteger(days) || days < min || days > MAX_ACTIVATION_GRACE_DAYS) {
    throw new RangeError(`${label} must be a whole number from ${min} to ${MAX_ACTIVATION_GRACE_DAYS}`);
  }
}

function assertDate(d: Date): void {
  if (Number.isNaN(d.getTime())) throw new RangeError("Invalid date");
}

/**
 * Signs an activation token valid for `graceDays` (default LICENSE_OFFLINE_GRACE_DAYS), but never past `notAfter` (the
 * license end): exp = min(iat + grace, notAfter), and always at least one second after iat (callers refuse expired
 * licenses before signing). Returns the compact JWT and its expiry, which /validate reports as `nextCheckBefore`.
 */
export async function signActivationToken(
  claims: ActivationClaims,
  opts: SignActivationTokenOptions = {},
): Promise<{ token: string; expiresAt: Date }> {
  assertClaims(claims);
  const now = opts.now ?? new Date();
  assertDate(now);
  const graceDays = opts.graceDays ?? getEnv().LICENSE_OFFLINE_GRACE_DAYS;
  assertDays(graceDays, 1, "Offline grace period");
  const pem = opts.privateKeyPem ?? getEnv().LICENSE_SIGNING_PRIVATE_KEY;
  const key = await cachedKey(privateKeys, pem, (p) => importPKCS8(p, ACTIVATION_TOKEN_ALG));

  const notAfter = opts.notAfter ?? null;
  if (notAfter !== null) assertDate(notAfter);

  // Whole seconds, as JWT NumericDate; expiresAt matches `exp` exactly.
  const iat = Math.floor(now.getTime() / 1000);
  const graceExp = iat + Math.round((graceDays * DAY_MS) / 1000);
  const exp = notAfter === null ? graceExp : Math.max(iat + 1, Math.min(graceExp, Math.floor(notAfter.getTime() / 1000)));
  const token = await new SignJWT({ lic: claims.lic, fp: claims.fp, prod: claims.prod })
    .setProtectedHeader({ alg: ACTIVATION_TOKEN_ALG, typ: ACTIVATION_TOKEN_TYPE })
    .setIssuer(ACTIVATION_TOKEN_ISSUER)
    .setAudience(ACTIVATION_TOKEN_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
  return { token, expiresAt: new Date(exp * 1000) };
}

/**
 * Verifies signature, algorithm, issuer, audience and claim shape. A token past `exp` is rejected with code
 * `expired`, unless it expired less than `allowExpiredForDays` ago: then it is returned with `expired: true` so
 * /validate can re-check the license and issue a fresh token.
 */
export async function verifyActivationToken(
  token: string,
  opts: VerifyActivationTokenOptions = {},
): Promise<VerifiedActivationToken> {
  const now = opts.now ?? new Date();
  assertDate(now);
  const windowDays = opts.allowExpiredForDays ?? 0;
  assertDays(windowDays, 0, "Expired-token window");
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_ACTIVATION_TOKEN_LENGTH) {
    throw new ActivationTokenError("invalid", "Activation token is invalid");
  }
  const pem = opts.publicKeyPem ?? getEnv().LICENSE_SIGNING_PUBLIC_KEY;
  const key = await cachedKey(publicKeys, pem, (p) => importSPKI(p, ACTIVATION_TOKEN_ALG));

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, key, {
      algorithms: [ACTIVATION_TOKEN_ALG],
      issuer: ACTIVATION_TOKEN_ISSUER,
      audience: ACTIVATION_TOKEN_AUDIENCE,
      typ: ACTIVATION_TOKEN_TYPE,
      requiredClaims: ["exp", "iat", "lic", "fp", "prod"],
      currentDate: now,
      // jose rejects exp <= now - tolerance, so the tolerance is exactly the refresh window.
      clockTolerance: Math.round((windowDays * DAY_MS) / 1000),
    });
    payload = result.payload;
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw new ActivationTokenError("expired", "Activation token has expired");
    throw new ActivationTokenError("invalid", "Activation token is invalid");
  }

  const { lic, fp, prod, exp } = payload;
  if (!isClaimString(lic) || !isClaimString(fp) || !isClaimString(prod) || typeof exp !== "number") {
    throw new ActivationTokenError("malformed", "Activation token claims are malformed");
  }
  const expiresAt = new Date(exp * 1000);
  return { claims: { lic, fp, prod }, expiresAt, expired: expiresAt.getTime() <= now.getTime() };
}
