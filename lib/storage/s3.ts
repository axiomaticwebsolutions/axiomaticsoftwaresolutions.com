/**
 * S3 (or S3-compatible) driver for the private installer and attachment bucket. Downloads are presigned GETs that
 * the browser fetches straight from S3/CloudFront, so file bytes never pass through the app servers.
 * The configuration is the effective storage configuration (lib/storage/index.ts createStorageDriver). With `guard`
 * (production) every connection's DNS lookup goes through the SSRF guard (lib/security/net-guard.ts guardedLookup).
 */
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { guardedLookup } from "@/lib/security/net-guard";
import {
  assertMaxBytes,
  assertStorageKey,
  assertTtl,
  attachmentDisposition,
  normalizeContentType,
  StorageError,
  type ObjectHead,
  type PresignedGet,
  type PresignedPut,
  type PresignGetOptions,
  type PresignPutOptions,
  type StorageDriver,
} from "./types";

export type S3StorageConfig = {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible stores (MinIO, R2); omit for AWS. */
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  /** Refuse private, loopback and link-local addresses at connect time (production). */
  guard?: boolean;
  now?: () => Date;
};

/** Connection timeout of every S3 request (a black-holed endpoint fails fast). */
export const S3_CONNECTION_TIMEOUT_MS = 10_000;

function isNotFound(e: unknown): boolean {
  const err = e as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
}

export class S3StorageDriver implements StorageDriver {
  readonly kind = "s3" as const;
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #now: () => Date;

  /** `client` is injectable for tests; by default one is built from `config`. */
  constructor(config: S3StorageConfig, client?: S3Client) {
    if (!config.bucket || !config.region) throw new StorageError("not_configured", "S3 storage needs a bucket and a region");
    this.#bucket = config.bucket;
    this.#now = config.now ?? (() => new Date());
    this.#client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle ?? false,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        // Without this the SDK adds CRC32 checksum parameters to presigned PUTs, which browser uploads cannot satisfy.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        requestHandler: requestHandlerOptions(config.guard === true),
      });
  }

  /** Releases the client's sockets (a replaced configuration). */
  destroy(): void {
    this.#client.destroy();
  }

  /** The object as a byte stream (server-side SHA-256 of uploaded installers). */
  async openRead(key: string): Promise<AsyncIterable<Uint8Array>> {
    assertStorageKey(key);
    const out = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    const body = out.Body;
    if (!body) throw new StorageError("invalid_request", "Empty object body");
    if (body instanceof Readable) return body;
    const web = (body as { transformToWebStream?: () => ReadableStream<Uint8Array> }).transformToWebStream?.();
    if (web) return Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]);
    throw new StorageError("invalid_request", "Unsupported object body");
  }

  #expiresAt(ttlSec: number): Date {
    return new Date(this.#now().getTime() + ttlSec * 1000);
  }

  async presignGet(key: string, opts: PresignGetOptions): Promise<PresignedGet> {
    assertStorageKey(key);
    assertTtl(opts.ttlSec);
    const expiresAt = this.#expiresAt(opts.ttlSec);
    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      ResponseContentDisposition: opts.downloadName ? attachmentDisposition(opts.downloadName) : undefined,
    });
    const url = await getSignedUrl(this.#client, command, { expiresIn: opts.ttlSec, signingDate: this.#now() });
    return { url, expiresAt };
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut> {
    assertStorageKey(key);
    assertTtl(opts.ttlSec);
    assertMaxBytes(opts.maxBytes);
    const contentType = normalizeContentType(opts.contentType);
    const expiresAt = this.#expiresAt(opts.ttlSec);
    const command = new PutObjectCommand({ Bucket: this.#bucket, Key: key, ContentType: contentType, ContentLength: opts.maxBytes });
    const url = await getSignedUrl(this.#client, command, {
      expiresIn: opts.ttlSec,
      signingDate: this.#now(),
      // Signing the content type stops a client from uploading something else under this URL, and signing the
      // length makes S3 refuse any body that is not exactly `maxBytes` long (a presigned PUT has no other size cap).
      signableHeaders: new Set(["content-type", "content-length"]),
    });
    // Browsers set Content-Length from the File/Blob body themselves (it is a forbidden request header).
    return { url, method: "PUT", headers: { "Content-Type": contentType }, expiresAt };
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    // S3 answers 204 for a key that does not exist, so deleting twice is fine.
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async head(key: string): Promise<ObjectHead | null> {
    assertStorageKey(key);
    try {
      const out = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return { sizeBytes: out.ContentLength ?? 0 };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    assertStorageKey(key);
    await this.#client.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: body, ContentType: normalizeContentType(contentType) }),
    );
  }
}

/** Keep-alive agents (with the guarded DNS lookup in production) and a connection timeout for the S3 client. */
function requestHandlerOptions(guard: boolean) {
  const lookup = guard ? guardedLookup() : undefined;
  return {
    httpsAgent: new https.Agent({ keepAlive: true, ...(lookup ? { lookup } : {}) }),
    httpAgent: new http.Agent({ keepAlive: true, ...(lookup ? { lookup } : {}) }),
    connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
  };
}
