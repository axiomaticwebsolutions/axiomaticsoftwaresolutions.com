/**
 * The storage bucket origin for the Content-Security-Policy `connect-src` (middleware.ts; docs/admin-integrations-design.md
 * section 11), from the RUNTIME storage configuration, so a bucket saved in Admin needs no rebuild.
 *
 * - Reads the shared resolver snapshot with allowStale: an expired snapshot answers at once (reloaded in the
 *   background); only a cold process with no snapshot waits, at most 1 s.
 * - s3 -> one exact origin (lib/storage/upload-origin.ts uploadOriginFor: the endpoint origin for path-style, else
 *   `<bucket>.<host>`), never a wildcard; local driver or not configured -> null.
 * - Never throws: any error -> null (a narrower policy: uploads fail visibly, the page still renders), logged
 *   csp_upload_origin_unavailable at most once a minute.
 */
import "server-only";
import { log } from "@/lib/log";
import { uploadOriginFor } from "@/lib/storage/upload-origin";
import { getIntegrationSnapshot } from "./resolver";

export const CSP_ORIGIN_MAX_WAIT_MS = 1_000;
let lastLogAt = 0;

/** The exact bucket origin for connect-src, or null (see the module comment). */
export async function uploadOriginForCsp(): Promise<string | null> {
  try {
    const { storage } = await getIntegrationSnapshot({ allowStale: true, maxWaitMs: CSP_ORIGIN_MAX_WAIT_MS });
    if (storage.source === "none" || storage.config.driver !== "s3") return null;
    const origin = uploadOriginFor(storage.config);
    // Defence in depth: the resolver only lets exact https/http origins through, never a wildcard.
    return origin && !origin.includes("*") ? origin : null;
  } catch (error) {
    const now = Date.now();
    if (now - lastLogAt >= 60_000) {
      lastLogAt = now;
      log.warn("csp_upload_origin_unavailable", { error: error instanceof Error ? error.name : typeof error });
    }
    return null;
  }
}
