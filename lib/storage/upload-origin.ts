/**
 * The origin browsers PUT presigned uploads to (ticket attachments, installers) and GET downloads from, for the
 * Content-Security-Policy `connect-src` (middleware.ts through lib/integrations/csp-origin.ts, from the RUNTIME storage
 * configuration). The local driver uploads to the app itself, so it needs nothing (null).
 *
 * Mirrors the AWS SDK's addressing for presigned URLs: path-style (the endpoint, or `s3.<region>.amazonaws.com`) when
 * forcePathStyle is on or the bucket name contains dots (not virtual-hostable over TLS), otherwise virtual-hosted
 * (`<bucket>.<host>`). Always one exact origin, never a wildcard. Returns null when the bucket, region or endpoint is
 * missing or malformed.
 *
 * Pure and dependency-free.
 */
export type UploadOriginInput = { bucket: string; region: string; endpoint: string | null | undefined; forcePathStyle: boolean };
export type UploadOriginEnv = Readonly<Record<string, string | undefined>>;

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]{2,32}$/;

/** The exact origin for a storage configuration (see the module comment). */
export function uploadOriginFor(input: UploadOriginInput): string | null {
  const bucket = input.bucket.trim();
  if (!BUCKET_RE.test(bucket)) return null;
  const pathStyle = input.forcePathStyle || bucket.includes(".");
  let base: URL;
  const endpoint = (input.endpoint ?? "").trim();
  if (endpoint) {
    try {
      base = new URL(endpoint);
    } catch {
      return null;
    }
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  } else {
    const region = input.region.trim();
    if (!REGION_RE.test(region)) return null;
    base = new URL(`https://s3.${region}.amazonaws.com`);
  }
  return pathStyle ? base.origin : `${base.protocol}//${bucket}.${base.host}`;
}

/** The same from STORAGE_* variables (STORAGE_DRIVER=s3 only). Kept for scripts; the app reads the resolver. */
export function storageUploadOrigin(env: UploadOriginEnv): string | null {
  if ((env.STORAGE_DRIVER ?? "local").trim() !== "s3") return null;
  return uploadOriginFor({
    bucket: env.STORAGE_BUCKET ?? "",
    region: env.STORAGE_REGION ?? "",
    endpoint: env.STORAGE_ENDPOINT,
    forcePathStyle: ["true", "1", "yes"].includes((env.STORAGE_FORCE_PATH_STYLE ?? "").trim().toLowerCase()),
  });
}
