/**
 * Release installer uploads (decisions.md Phase 6 "Releases"; api-contracts POST /api/admin/releases/:id/files).
 *
 * 1. POST .../files { platform, fileName, sizeBytes } returns a presigned PUT (10 minutes; Content-Type
 *    application/octet-stream and the exact size are signed) for a fresh key under the release's storage prefix, plus
 *    an upload token: an HMAC-signed note of what was authorised (release, version, platform, key, name, size, staff,
 *    expiry). Nothing is written to the database yet.
 * 2. The browser PUTs the file straight to storage (S3, or the dev-only /api/dev/storage route).
 * 3. POST .../files/confirm { uploadToken } checks the token, that the object exists with exactly the declared size,
 *    and computes its SHA-256 on the server by reading the object (local driver: the file; S3: a streamed GET), then
 *    stores the ReleaseFile row. The client never supplies the hash.
 *
 * Storage keys never leave the server except inside the signed URL. Server-only.
 */
import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { getEnv } from "@/lib/env";
import { isStorageKey, type StorageDriver } from "@/lib/storage";
import { LocalStorageDriver } from "@/lib/storage/local";
import type { CatalogPlatform } from "./types";

/** Every installer is stored as opaque bytes; the download name carries the extension. */
export const INSTALLER_CONTENT_TYPE = "application/octet-stream";
/** Presigned PUT lifetime (S3 checks it when the upload starts). */
export const INSTALLER_PUT_TTL_SECONDS = 600;
/** How long a token can confirm its upload (large installers on slow links take a while). */
export const UPLOAD_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export type UploadTokenClaims = {
  /** Release id. */
  r: string;
  /** Release version when the upload was authorised (the key's prefix uses it). */
  v: string;
  p: CatalogPlatform;
  /** Storage key. */
  k: string;
  /** Safe download name. */
  n: string;
  /** Exact size in bytes. */
  s: number;
  /** Staff user who asked for the upload. */
  u: string;
  /** Expiry, unix seconds. */
  e: number;
};

function tokenKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("axs:release-upload:v1", "utf8").digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** "<payload>.<signature>", both base64url. */
export function signUploadToken(claims: UploadTokenClaims, secret: string = getEnv().SESSION_SECRET): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = b64url(createHmac("sha256", tokenKey(secret)).update(payload, "utf8").digest());
  return `${payload}.${sig}`;
}

const PLATFORMS: ReadonlySet<string> = new Set(["windows", "macos", "android"]);

function isClaims(v: unknown): v is UploadTokenClaims {
  const c = v as Record<string, unknown> | null;
  return (
    !!c &&
    typeof c.r === "string" &&
    typeof c.v === "string" &&
    typeof c.p === "string" &&
    PLATFORMS.has(c.p) &&
    typeof c.k === "string" &&
    isStorageKey(c.k) &&
    typeof c.n === "string" &&
    typeof c.s === "number" &&
    Number.isSafeInteger(c.s) &&
    c.s > 0 &&
    typeof c.u === "string" &&
    typeof c.e === "number"
  );
}

/** The claims of a valid, unexpired token, else null (never throws; constant-time signature check). */
export function verifyUploadToken(token: string, now: Date = new Date(), secret: string = getEnv().SESSION_SECRET): UploadTokenClaims | null {
  try {
    const [payload, sig, extra] = token.split(".");
    if (!payload || !sig || extra !== undefined) return null;
    const expected = createHmac("sha256", tokenKey(secret)).update(payload, "utf8").digest();
    const actual = Buffer.from(sig, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isClaims(claims)) return null;
    if (claims.e * 1000 <= now.getTime()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** A random key segment, so a replaced installer never overwrites the object customers may still be downloading. */
export function uploadNonce(): string {
  return randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x");
}

/** Optional capability of a storage driver: read an object as a stream (S3StorageDriver.openRead; tests). */
export type ReadableStorage = { openRead(key: string): Promise<AsyncIterable<Uint8Array>> };

function hasOpenRead(s: unknown): s is ReadableStorage {
  return typeof (s as Partial<ReadableStorage> | null)?.openRead === "function";
}

/** Reads through the same driver (and so the same effective storage configuration) the upload was presigned with. */
async function openObject(storage: StorageDriver, key: string): Promise<AsyncIterable<Uint8Array>> {
  if (hasOpenRead(storage)) return storage.openRead(key);
  if (storage instanceof LocalStorageDriver) return createReadStream(storage.pathFor(key));
  throw new Error(`Storage driver "${storage.kind}" cannot be read`);
}

/** SHA-256 (hex) and byte count of a stored object, streamed (never buffered whole). */
export async function hashStoredObject(storage: StorageDriver, key: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of await openObject(storage, key)) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), sizeBytes: size };
}
