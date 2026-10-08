/**
 * Storage driver selection and the download-link TTL clamp. Server code only.
 *
 * getStorage() returns the driver of the effective storage configuration (lib/integrations/resolver.ts: Admin >
 * Settings > Integrations, else the env fallback), rebuilt when that configuration changes (the old S3 client is
 * destroyed a minute later, so requests in flight finish). Not configured -> StorageError("not_configured"); callers
 * answer their existing 503 codes (upload_unavailable / download_unavailable). The local driver is development-only:
 * the env fallback refuses it in production and Admin cannot choose it.
 */
import "server-only";
import { getEnv, isProduction } from "@/lib/env";
import { resolveStorage } from "@/lib/integrations/resolver";
import type { StorageConfig } from "@/lib/integrations/types";
import { LocalStorageDriver } from "./local";
import { S3StorageDriver } from "./s3";
import { MAX_PRESIGN_TTL_SECONDS, StorageError, type StorageDriver } from "./types";

export * from "./types";

/** A replaced driver is destroyed this long after the configuration changed. */
const RETIRE_AFTER_MS = 60_000;

let override: StorageDriver | null = null;
let current: { fingerprint: string; driver: StorageDriver } | null = null;

/** A driver for a configuration (the process-wide one, or a one-off for the Admin "Test bucket" probe). */
export function createStorageDriver(config: StorageConfig): StorageDriver {
  if (config.driver === "local") {
    if (isProduction()) throw new StorageError("not_configured", "The local storage driver is not allowed in production");
    const env = getEnv();
    return new LocalStorageDriver({ dir: config.dir, appUrl: env.APP_URL, secret: env.SESSION_SECRET });
  }
  return new S3StorageDriver({
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    guard: isProduction(),
  });
}

function retire(driver: StorageDriver): void {
  if (!(driver instanceof S3StorageDriver)) return;
  const timer = setTimeout(() => driver.destroy(), RETIRE_AFTER_MS);
  timer.unref?.();
}

/** The driver of the effective storage configuration. Throws StorageError("not_configured") when there is none. */
export async function getStorage(): Promise<StorageDriver> {
  if (override) return override;
  const resolved = await resolveStorage();
  if (resolved.source === "none") throw new StorageError("not_configured", "File storage is not configured");
  if (current?.fingerprint !== resolved.fingerprint) {
    if (current) retire(current.driver);
    current = { fingerprint: resolved.fingerprint, driver: createStorageDriver(resolved.config) };
  }
  return current.driver;
}

/** Replaces the driver (tests). Pass null to go back to the effective configuration's. */
export function setStorage(next: StorageDriver | null): void {
  override = next;
}

/**
 * Presigned link lifetime: min(requested, DOWNLOAD_LINK_TTL_SECONDS, 600), in whole seconds and at least 1.
 * lib/config.ts downloadTtlSeconds() applies the admin setting on top; pass its result here.
 */
export function clampTtl(requested: number, envTtlSeconds: number = getEnv().DOWNLOAD_LINK_TTL_SECONDS): number {
  if (Number.isNaN(requested) || Number.isNaN(envTtlSeconds)) throw new RangeError("TTL must be a number of seconds");
  // Infinity means "as long as allowed"; the caps below still apply.
  const wanted = Number.isFinite(requested) ? Math.floor(requested) : MAX_PRESIGN_TTL_SECONDS;
  return Math.max(1, Math.min(wanted, envTtlSeconds, MAX_PRESIGN_TTL_SECONDS));
}
