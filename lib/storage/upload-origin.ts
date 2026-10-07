/**
 * The origin browsers PUT presigned uploads to (ticket attachments), for the Content-Security-Policy `connect-src` of
 * the pages that upload (next.config.ts). The local driver uploads to the app itself, so it needs nothing (null).
 *
 * Mirrors the AWS SDK's addressing for presigned URLs: path-style (the endpoint, or `s3.<region>.amazonaws.com`) when
 * STORAGE_FORCE_PATH_STYLE is on or the bucket name contains dots (not virtual-hostable over TLS), otherwise
 * virtual-hosted (`<bucket>.<host>`). Returns null when the bucket, region or endpoint is missing or malformed.
 *
 * Pure and dependency-free, because next.config.ts imports it. next.config headers are computed by `next build`, so
 * the STORAGE_* variables must be present when the production build runs (docs/decisions.md Phase 5 build decisions).
 */
export type UploadOriginEnv = Readonly<Record<string, string | undefined>>;

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]{2,32}$/;

export function storageUploadOrigin(env: UploadOriginEnv): string | null {
  if ((env.STORAGE_DRIVER ?? "local").trim() !== "s3") return null;
  const bucket = (env.STORAGE_BUCKET ?? "").trim();
  if (!BUCKET_RE.test(bucket)) return null;
  const pathStyle = ["true", "1", "yes"].includes((env.STORAGE_FORCE_PATH_STYLE ?? "").trim().toLowerCase()) || bucket.includes(".");

  let base: URL;
  const endpoint = (env.STORAGE_ENDPOINT ?? "").trim();
  if (endpoint) {
    try {
      base = new URL(endpoint);
    } catch {
      return null;
    }
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  } else {
    const region = (env.STORAGE_REGION ?? "").trim();
    if (!REGION_RE.test(region)) return null;
    base = new URL(`https://s3.${region}.amazonaws.com`);
  }
  return pathStyle ? base.origin : `${base.protocol}//${bucket}.${base.host}`;
}
