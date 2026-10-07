/**
 * Private object storage behind one interface: S3 (production) and a local dev driver that the app serves through
 * short-lived HMAC-signed URLs. Storage keys never leave the server except inside a signed URL.
 */

export type StorageDriverKind = "s3" | "local";

export type PresignGetOptions = {
  ttlSec: number;
  /** Suggested file name for the browser's save dialog (Content-Disposition: attachment). */
  downloadName?: string;
};
/** `maxBytes`: the exact size of the file to upload (S3 signs it as Content-Length; the local route caps at it). */
export type PresignPutOptions = { ttlSec: number; contentType: string; maxBytes: number };

export type PresignedGet = { url: string; expiresAt: Date };
/** The client must send exactly `headers` with the PUT, or the signature check fails. */
export type PresignedPut = { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: Date };
export type ObjectHead = { sizeBytes: number };

export interface StorageDriver {
  readonly kind: StorageDriverKind;
  presignGet(key: string, opts: PresignGetOptions): Promise<PresignedGet>;
  /**
   * Presigned upload. The content type is part of the signature. Pass the file's exact size as `maxBytes`: S3 signs
   * it as the Content-Length (any other length is refused); the local driver's route refuses bodies above it. Callers
   * still check head(key).sizeBytes before accepting an upload.
   */
  presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut>;
  head(key: string): Promise<ObjectHead | null>;
  /** Removes an object; a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Server-side write for dev, tests and the seed; never on a request path. */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
}

/** No presigned URL lives longer than this, whatever the caller asks for. */
export const MAX_PRESIGN_TTL_SECONDS = 600;
export const MAX_STORAGE_KEY_LENGTH = 512;
const STORAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const MAX_DOWNLOAD_NAME = 150;

export type StorageErrorCode = "invalid_key" | "invalid_request" | "not_configured";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

/** Keys are "/"-separated segments of [A-Za-z0-9._-] that start with a letter or digit, so ".." can never appear. */
export function isStorageKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= MAX_STORAGE_KEY_LENGTH && STORAGE_KEY_RE.test(key);
}

export function assertStorageKey(key: string): void {
  if (!isStorageKey(key)) throw new StorageError("invalid_key", "Invalid storage key");
}

export function assertTtl(ttlSec: number): void {
  if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_PRESIGN_TTL_SECONDS) {
    throw new StorageError("invalid_request", `ttlSec must be a whole number from 1 to ${MAX_PRESIGN_TTL_SECONDS}`);
  }
}

/** Lower-cased "type/subtype" without parameters; throws for anything else. */
export function normalizeContentType(contentType: string): string {
  const value = contentType.trim().toLowerCase();
  if (!CONTENT_TYPE_RE.test(value)) throw new StorageError("invalid_request", "Invalid content type");
  return value;
}

export function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new StorageError("invalid_request", "maxBytes must be a positive integer");
}

/** RFC 5987 value: encodeURIComponent leaves ' ( ) * unescaped, which attr-char does not allow. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`);
}

/** Drops control characters, quotes, slashes and backslashes; keeps the name readable. */
export function sanitizeDownloadName(name: string): string {
  const cleaned = Array.from(name.normalize("NFC"))
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f && ch !== '"' && ch !== "/" && ch !== "\x5C";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return Array.from(cleaned).slice(0, MAX_DOWNLOAD_NAME).join("").trim() || "download";
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<utf8>` for a safe download name (RFC 6266). */
export function attachmentDisposition(fileName: string): string {
  const name = sanitizeDownloadName(fileName);
  const ascii = Array.from(name)
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c < 0x7f && ch !== "%" && ch !== ";" ? ch : "_";
    })
    .join("");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
