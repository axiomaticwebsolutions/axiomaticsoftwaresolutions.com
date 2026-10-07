import { createPublicKey, generateKeyPairSync, randomBytes, verify as cryptoVerify } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, importPKCS8, SignJWT, UnsecuredJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAY_MS } from "@/lib/dates";
import { resetEnvCache } from "@/lib/env";
import {
  ACTIVATION_TOKEN_AUDIENCE,
  ACTIVATION_TOKEN_ISSUER,
  ActivationTokenError,
  signActivationToken,
  verifyActivationToken,
  type ActivationClaims,
} from "@/lib/licensing/activation-token";

function keyPair() {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

const pair = keyPair();
const other = keyPair();
const claims: ActivationClaims = { lic: "LIC-24017", fp: "a".repeat(64), prod: "MED" };
const now = new Date("2026-10-06T10:00:00.000Z");
const sign = (extra: { graceDays?: number; now?: Date; notAfter?: Date | null } = {}) =>
  signActivationToken(claims, { privateKeyPem: pair.privateKey, graceDays: 7, now, ...extra });
const verifyAt = (token: string, at: Date, allowExpiredForDays?: number, publicKeyPem = pair.publicKey) =>
  verifyActivationToken(token, { publicKeyPem, now: at, allowExpiredForDays });

async function expectCode(promise: Promise<unknown>, code: ActivationTokenError["code"]) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ActivationTokenError);
  expect((error as ActivationTokenError).code).toBe(code);
}

/** Re-signs arbitrary claims with the real private key (to test claim and issuer checks). */
async function forge(payload: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: number } = {}) {
  const key = await importPKCS8(pair.privateKey, "EdDSA");
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(opts.iss ?? ACTIVATION_TOKEN_ISSUER)
    .setAudience(opts.aud ?? ACTIVATION_TOKEN_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + 7 * 86_400)
    .sign(key);
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("signActivationToken", () => {
  it("signs an EdDSA JWT with the contract claims and a 7-day expiry", async () => {
    const { token, expiresAt } = await sign();
    expect(decodeProtectedHeader(token)).toEqual({ alg: "EdDSA", typ: "JWT" });
    const payload = decodeJwt(token);
    expect(payload).toMatchObject({ ...claims, iss: "axiomatic", aud: "axiomatic-apps" });
    expect(payload.iat).toBe(now.getTime() / 1000);
    expect(payload.exp).toBe(now.getTime() / 1000 + 7 * 86_400);
    expect(expiresAt.getTime()).toBe(now.getTime() + 7 * DAY_MS);
  });

  it("produces a signature the apps can check offline with only the public key", async () => {
    const { token } = await sign();
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const ok = cryptoVerify(null, Buffer.from(`${header}.${payload}`), createPublicKey(pair.publicKey), Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  it("honours graceDays and floors sub-second times", async () => {
    const at = new Date("2026-10-06T10:00:00.900Z");
    const { expiresAt } = await sign({ graceDays: 3, now: at });
    expect(expiresAt.toISOString()).toBe("2026-10-09T10:00:00.000Z");
  });

  it("never signs past notAfter (the license end), and stays valid for at least a second", async () => {
    // A license ending in 2 days: exp is the end date, not now + 7 days.
    const end = new Date(now.getTime() + 2 * DAY_MS + 1_500);
    const capped = await sign({ notAfter: end });
    expect(capped.expiresAt.getTime()).toBe(now.getTime() + 2 * DAY_MS + 1_000);
    expect(decodeJwt(capped.token).exp).toBe(capped.expiresAt.getTime() / 1000);
    // A license ending after the grace period, and a perpetual one, keep now + grace.
    expect((await sign({ notAfter: new Date(now.getTime() + 30 * DAY_MS) })).expiresAt.getTime()).toBe(now.getTime() + 7 * DAY_MS);
    expect((await sign({ notAfter: null })).expiresAt.getTime()).toBe(now.getTime() + 7 * DAY_MS);
    // Within the same second as iat (callers refuse ended licenses before signing): one second, never exp <= iat.
    expect((await sign({ notAfter: new Date(now.getTime() + 400) })).expiresAt.getTime()).toBe(now.getTime() + 1_000);
    await expect(sign({ notAfter: new Date(Number.NaN) })).rejects.toThrow(RangeError);
  });

  it("rejects bad claims and grace periods", async () => {
    await expect(signActivationToken({ ...claims, lic: "" }, { privateKeyPem: pair.privateKey, graceDays: 7 })).rejects.toThrow(RangeError);
    await expect(signActivationToken({ ...claims, fp: "x".repeat(129) }, { privateKeyPem: pair.privateKey, graceDays: 7 })).rejects.toThrow(RangeError);
    await expect(signActivationToken({ ...claims, prod: "ME\nD" }, { privateKeyPem: pair.privateKey, graceDays: 7 })).rejects.toThrow(RangeError);
    await expect(sign({ graceDays: 0 })).rejects.toThrow(RangeError);
    await expect(sign({ graceDays: 31 })).rejects.toThrow(RangeError);
    await expect(sign({ graceDays: 1.5 })).rejects.toThrow(RangeError);
  });

  it("fails on an unusable private key without poisoning later calls", async () => {
    await expect(signActivationToken(claims, { privateKeyPem: "not a pem", graceDays: 7, now })).rejects.toThrow();
    await expect(signActivationToken(claims, { privateKeyPem: "not a pem", graceDays: 7, now })).rejects.toThrow();
    await expect(sign()).resolves.toMatchObject({ token: expect.any(String) });
  });
});

describe("verifyActivationToken", () => {
  it("round-trips the claims before expiry", async () => {
    const { token, expiresAt } = await sign();
    const result = await verifyAt(token, new Date(now.getTime() + 6 * DAY_MS));
    expect(result).toEqual({ claims, expiresAt, expired: false });
  });

  it("rejects an expired token with code expired", async () => {
    const { token } = await sign();
    await expectCode(verifyAt(token, new Date(now.getTime() + 7 * DAY_MS)), "expired");
    await expectCode(verifyAt(token, new Date(now.getTime() + 30 * DAY_MS)), "expired");
  });

  it("accepts a recently expired token inside allowExpiredForDays, flagged as expired", async () => {
    const { token, expiresAt } = await sign();
    const atExpiry = await verifyAt(token, expiresAt, 3);
    expect(atExpiry).toMatchObject({ claims, expired: true });
    const later = await verifyAt(token, new Date(expiresAt.getTime() + 3 * DAY_MS - 1000), 3);
    expect(later.expired).toBe(true);
    await expectCode(verifyAt(token, new Date(expiresAt.getTime() + 3 * DAY_MS), 3), "expired");
    // The window never makes a live token look expired.
    expect((await verifyAt(token, now, 3)).expired).toBe(false);
  });

  it("rejects tampered payloads and signatures", async () => {
    const { token } = await sign();
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ ...decodeJwt(token), fp: "b".repeat(64) })).toString("base64url");
    await expectCode(verifyAt(`${header}.${forgedPayload}.${signature}`, now), "invalid");
    const flipped = (signature.startsWith("A") ? "B" : "A") + signature.slice(1);
    await expectCode(verifyAt(`${header}.${payload}.${flipped}`, now), "invalid");
    await expectCode(verifyAt(`${header}.${payload}`, now), "invalid");
  });

  it("rejects a token signed with another key", async () => {
    const { token } = await signActivationToken(claims, { privateKeyPem: other.privateKey, graceDays: 7, now });
    await expectCode(verifyAt(token, now), "invalid");
    await expect(verifyAt(token, now, 0, other.publicKey)).resolves.toMatchObject({ claims });
  });

  it("enforces issuer, audience and algorithm", async () => {
    await expectCode(verifyAt(await forge({ ...claims }, { iss: "someone-else" }), now), "invalid");
    await expectCode(verifyAt(await forge({ ...claims }, { aud: "axiomatic-web" }), now), "invalid");
    const unsecured = new UnsecuredJWT({ ...claims })
      .setIssuer(ACTIVATION_TOKEN_ISSUER)
      .setAudience(ACTIVATION_TOKEN_AUDIENCE)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + 3600)
      .encode();
    await expectCode(verifyAt(unsecured, now), "invalid");
  });

  it("separates missing claims (invalid) from wrongly typed claims (malformed)", async () => {
    await expectCode(verifyAt(await forge({ lic: claims.lic, prod: claims.prod }), now), "invalid");
    await expectCode(verifyAt(await forge({ ...claims, fp: 42 }), now), "malformed");
    await expectCode(verifyAt(await forge({ ...claims, lic: "" }), now), "malformed");
  });

  it("rejects junk input without throwing anything but ActivationTokenError", async () => {
    await expectCode(verifyAt("", now), "invalid");
    await expectCode(verifyAt("not.a.jwt", now), "invalid");
    await expectCode(verifyAt("x".repeat(5000), now), "invalid");
  });

  it("validates the expired-token window", async () => {
    const { token } = await sign();
    await expect(verifyAt(token, now, -1)).rejects.toThrow(RangeError);
    await expect(verifyAt(token, now, 31)).rejects.toThrow(RangeError);
  });
});

describe("environment defaults", () => {
  function stubEnv() {
    const values: Record<string, string> = {
      APP_URL: "http://localhost:3000",
      NODE_ENV: "test",
      SESSION_SECRET: randomBytes(48).toString("base64url"),
      CSRF_SECRET: randomBytes(32).toString("base64url"),
      ORDER_TOKEN_SECRET: randomBytes(32).toString("base64url"),
      CRON_SECRET: randomBytes(32).toString("base64url"),
      DATABASE_URL: "postgresql://axiomatic:axiomatic@localhost:5432/axiomatic?schema=public",
      LICENSE_KEY_PEPPER: randomBytes(32).toString("hex"),
      LICENSE_KEY_ENC_KEY: randomBytes(32).toString("base64"),
      LICENSE_SIGNING_PRIVATE_KEY: pair.privateKey,
      LICENSE_SIGNING_PUBLIC_KEY: pair.publicKey,
      LICENSE_OFFLINE_GRACE_DAYS: "5",
      PAYMENT_PROVIDER: "mock",
      PAYMENT_KEY_ID: "mock_key",
      PAYMENT_KEY_SECRET: randomBytes(24).toString("base64url"),
      PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString("base64url"),
      STORAGE_DRIVER: "local",
      EMAIL_TRANSPORT: "console",
      EMAIL_FROM: "Axiomatic Software <no-reply@axiomatic.example>",
    };
    for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
    resetEnvCache();
  }

  it("uses LICENSE_OFFLINE_GRACE_DAYS and the env key pair when no options are given", async () => {
    stubEnv();
    const { token, expiresAt } = await signActivationToken(claims, { now });
    expect(expiresAt.getTime()).toBe(now.getTime() + 5 * DAY_MS);
    await expect(verifyActivationToken(token, { now })).resolves.toMatchObject({ claims, expired: false });
  });
});
