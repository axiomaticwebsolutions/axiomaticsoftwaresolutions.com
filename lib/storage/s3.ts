/**
 * S3 (or S3-compatible) driver for the private installer and attachment bucket. Downloads are presigned GETs that
 * the browser fetches straight from S3/CloudFront, so file bytes never pass through the app servers.
 */
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnv } from "@/lib/env";
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
  now?: () => Date;
};

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
      });
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

/** Driver configured from STORAGE_* variables (lib/env.ts guarantees bucket, region and credentials for s3). */
export function s3StorageFromEnv(): S3StorageDriver {
  const env = getEnv();
  if (!env.STORAGE_BUCKET || !env.STORAGE_REGION || !env.STORAGE_ACCESS_KEY_ID || !env.STORAGE_SECRET_ACCESS_KEY) {
    throw new StorageError("not_configured", "STORAGE_BUCKET, STORAGE_REGION and S3 credentials are required for STORAGE_DRIVER=s3");
  }
  return new S3StorageDriver({
    bucket: env.STORAGE_BUCKET,
    region: env.STORAGE_REGION,
    endpoint: env.STORAGE_ENDPOINT,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
  });
}
