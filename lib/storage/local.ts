/**
 * Local storage driver for development only (the env fallback refuses STORAGE_DRIVER=local in production and Admin
 * cannot choose it; lib/storage/index.ts createStorageDriver builds it).
 * Objects are files under STORAGE_LOCAL_DIR. Presigned URLs point at the app's dev route,
 * "<APP_URL>/api/dev/storage/<key>?exp=<unix seconds>&sig=<hex HMAC>", which checks verifyLocalSignature().
 *
 * Signed string: "GET|<key>|<exp>" for downloads and "PUT|<key>|<exp>|<maxBytes>|<contentType>" for uploads, so the
 * upload route can trust the `max` and `ct` query parameters. The HMAC key is derived from SESSION_SECRET with a
 * purpose label, so these signatures can never be confused with other SESSION_SECRET uses.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "@/lib/env";
import {
  assertMaxBytes,
  assertStorageKey,
  assertTtl,
  isStorageKey,
  MAX_PRESIGN_TTL_SECONDS,
  normalizeContentType,
  StorageError,
  type ObjectHead,
  type PresignedGet,
  type PresignedPut,
  type PresignGetOptions,
  type PresignPutOptions,
  type StorageDriver,
} from "./types";

export const LOCAL_STORAGE_ROUTE = "/api/dev/storage";
export type LocalStorageMethod = "GET" | "PUT";
export type LocalStorageConfig = { dir: string; appUrl: string; secret: string; now?: () => Date };
/** Upload constraints carried in a PUT URL (`max` and `ct` query parameters) and bound into its signature. */
export type LocalPutConstraints = { maxBytes: number; contentType: string };
export type VerifyLocalOptions = { secret?: string } & Partial<LocalPutConstraints>;

/** Clock skew tolerated when rejecting expiries that are further away than any URL we sign. */
const MAX_FUTURE_SKEW_SECONDS = 60;
const SIG_RE = /^[0-9a-f]{64}$/;
const EXP_RE = /^[0-9]{1,12}$/;

function signingKey(secret: string): Buffer {
  if (secret.length === 0) throw new StorageError("not_configured", "Local storage signing secret is empty");
  return createHmac("sha256", secret).update("axs:local-storage:v1", "utf8").digest();
}

function signedString(method: LocalStorageMethod, key: string, exp: number, put?: LocalPutConstraints): string {
  const base = `${method}|${key}|${exp}`;
  return put ? `${base}|${put.maxBytes}|${put.contentType}` : base;
}

/** Hex HMAC for a local storage request. Exported for the dev route's tests. */
export function signLocalRequest(method: LocalStorageMethod, key: string, exp: number, secret: string, put?: LocalPutConstraints): string {
  return createHmac("sha256", signingKey(secret)).update(signedString(method, key, exp, put), "utf8").digest("hex");
}

/** "releases/med/4.2.1/setup.exe" -> per-segment URI encoding for a `[...key]` catch-all route. */
export function encodeStorageKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function parseExp(exp: string | number): number | null {
  if (typeof exp === "number") return Number.isSafeInteger(exp) && exp > 0 ? exp : null;
  return EXP_RE.test(exp) ? Number(exp) : null;
}

/**
 * Checks a local storage URL: known method, valid key, not expired, not suspiciously far in the future, and a
 * matching signature (constant time). PUT also needs the `maxBytes` and `contentType` from the URL. Never throws.
 */
export function verifyLocalSignature(
  method: string,
  key: string,
  exp: string | number,
  sig: string,
  now: Date,
  opts: VerifyLocalOptions = {},
): boolean {
  try {
    const m = method.toUpperCase();
    if ((m !== "GET" && m !== "PUT") || !isStorageKey(key) || typeof sig !== "string" || !SIG_RE.test(sig)) return false;
    const expSec = parseExp(exp);
    const nowMs = now.getTime();
    if (expSec === null || Number.isNaN(nowMs)) return false;
    if (expSec * 1000 <= nowMs) return false;
    if (expSec * 1000 - nowMs > (MAX_PRESIGN_TTL_SECONDS + MAX_FUTURE_SKEW_SECONDS) * 1000) return false;

    let put: LocalPutConstraints | undefined;
    if (m === "PUT") {
      const { maxBytes, contentType } = opts;
      if (maxBytes === undefined || contentType === undefined || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return false;
      put = { maxBytes, contentType };
    }
    const expected = Buffer.from(signLocalRequest(m, key, expSec, opts.secret ?? getEnv().SESSION_SECRET, put), "hex");
    const actual = Buffer.from(sig, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function isMissingFileError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Dev-only driver: files under `dir`, URLs signed for the app's /api/dev/storage route. */
export class LocalStorageDriver implements StorageDriver {
  readonly kind = "local" as const;
  /** Absolute storage root. */
  readonly root: string;
  readonly #appUrl: string;
  readonly #secret: string;
  readonly #now: () => Date;

  constructor(config: LocalStorageConfig) {
    if (config.dir.trim().length === 0) throw new StorageError("not_configured", "STORAGE_LOCAL_DIR is empty");
    signingKey(config.secret);
    this.root = path.resolve(config.dir);
    this.#appUrl = config.appUrl.replace(/\/+$/, "");
    this.#secret = config.secret;
    this.#now = config.now ?? (() => new Date());
  }

  /** Absolute path of an object. Throws StorageError for invalid keys; the result is always inside `root`. */
  pathFor(key: string): string {
    assertStorageKey(key);
    const full = path.resolve(this.root, ...key.split("/"));
    if (!full.startsWith(this.root + path.sep)) throw new StorageError("invalid_key", "Invalid storage key");
    return full;
  }

  #url(key: string, exp: number, sig: string, extra: Record<string, string>): string {
    const query = new URLSearchParams({ exp: String(exp), sig, ...extra });
    return `${this.#appUrl}${LOCAL_STORAGE_ROUTE}/${encodeStorageKeyPath(key)}?${query.toString()}`;
  }

  #expiry(ttlSec: number): number {
    assertTtl(ttlSec);
    return Math.floor(this.#now().getTime() / 1000) + ttlSec;
  }

  async presignGet(key: string, opts: PresignGetOptions): Promise<PresignedGet> {
    assertStorageKey(key);
    const exp = this.#expiry(opts.ttlSec);
    const sig = signLocalRequest("GET", key, exp, this.#secret);
    // The download name is not signed: the route only uses it, sanitised, for Content-Disposition.
    const extra: Record<string, string> = opts.downloadName ? { name: opts.downloadName } : {};
    return { url: this.#url(key, exp, sig, extra), expiresAt: new Date(exp * 1000) };
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut> {
    assertStorageKey(key);
    assertMaxBytes(opts.maxBytes);
    const contentType = normalizeContentType(opts.contentType);
    const exp = this.#expiry(opts.ttlSec);
    const sig = signLocalRequest("PUT", key, exp, this.#secret, { maxBytes: opts.maxBytes, contentType });
    return {
      url: this.#url(key, exp, sig, { max: String(opts.maxBytes), ct: contentType }),
      method: "PUT",
      headers: { "Content-Type": contentType },
      expiresAt: new Date(exp * 1000),
    };
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const s = await stat(this.pathFor(key));
      return s.isFile() ? { sizeBytes: s.size } : null;
    } catch (e) {
      if (isMissingFileError(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    normalizeContentType(contentType);
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Write then rename, so a reader never sees a half-written file. The leading dot keeps the temp name unaddressable.
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, body);
      await rename(temp, target);
    } catch (e) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
}

