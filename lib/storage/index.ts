/**
 * Storage driver selection (STORAGE_DRIVER) and the download-link TTL clamp. Server code only.
 */
import { getEnv, isProduction } from "@/lib/env";
import { localStorageFromEnv } from "./local";
import { s3StorageFromEnv } from "./s3";
import { MAX_PRESIGN_TTL_SECONDS, StorageError, type StorageDriver } from "./types";

export * from "./types";

let driver: StorageDriver | null = null;

/** The configured driver (one per process). The local driver is refused in production. */
export function getStorage(): StorageDriver {
  if (driver) return driver;
  const kind = getEnv().STORAGE_DRIVER;
  if (kind === "local") {
    if (isProduction()) throw new StorageError("not_configured", "STORAGE_DRIVER=local is not allowed in production");
    driver = localStorageFromEnv();
  } else {
    driver = s3StorageFromEnv();
  }
  return driver;
}

/** Replaces or drops the cached driver (tests). */
export function setStorage(next: StorageDriver | null): void {
  driver = next;
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
