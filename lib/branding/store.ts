/**
 * Branding storage (BrandAsset rows in PostgreSQL; docs/decisions.md "Branding: logos and favicon"). Server-only.
 *
 * - loadBrandingState: what every page needs (slot, type, size, version), never the bytes.
 * - saveBrandAsset / removeBrandAsset (settings.manage = Owner): one transaction with the AuditLog row ("Uploaded",
 *   "Replaced" or "Removed branding image": slot, MIME type, byte size and the first 12 hex characters of the SHA-256,
 *   never the bytes), then the storefront settings cache is revalidated (revalidateTag STOREFRONT_TAGS.settings: every
 *   page carries it through the root layout, so static and ISR pages regenerate on their next request).
 * - readBrandFile: the bytes for GET /brand/:file, cached in this process for 30 seconds per slot. A request for
 *   another version re-reads the database at most every 2 seconds per slot (other PM2 processes learn of an upload
 *   that way); until then the route answers with the bytes it has and Cache-Control no-store, so no cache keeps old
 *   bytes under a new version. The favicon's apple-touch-icon (variant "apple") is flattened once per cached file.
 * - invoiceLogo / emailLogo: the light logo's PNG rendition for PDFs, the absolute rendition URLs for emails.
 */
import "server-only";
import { revalidateTag } from "next/cache";
import type { StaffRole } from "@/generated/prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { db as defaultDb, type Db } from "@/lib/db";
import { errors } from "@/lib/http";
import { log } from "@/lib/log";
import { can, roleForbiddenMessage } from "@/lib/rbac";
import { SITE_NAME } from "@/lib/seo/metadata";
import { STOREFRONT_TAGS } from "@/lib/storefront/data";
import {
  BRAND_AUDIT_ACTIONS,
  BRAND_SLOT_DB,
  BRANDING_COPY,
  brandVersion,
  EMPTY_BRANDING,
  emailLogoFrom,
  formatFromMime,
  slotFromDb,
  type BrandAssetInfo,
  type BrandFileVariant,
  type BrandFormat,
  type BrandingState,
  type BrandSlot,
  type EmailLogo,
  type RasterLogo,
} from "./model";
import type { ProcessedBrandAsset } from "./process";

const INFO_SELECT = {
  slot: true,
  mime: true,
  sha256: true,
  width: true,
  height: true,
  byteSize: true,
  pngWidth: true,
  pngHeight: true,
  updatedAt: true,
  updatedBy: { select: { name: true, email: true } },
} as const;

type InfoRow = {
  slot: string;
  mime: string;
  sha256: string;
  width: number;
  height: number;
  byteSize: number;
  pngWidth: number | null;
  pngHeight: number | null;
  updatedAt: Date;
  updatedBy: { name: string; email: string } | null;
};

function toInfo(row: InfoRow): BrandAssetInfo | null {
  const slot = slotFromDb(row.slot);
  const format = formatFromMime(row.mime);
  if (!slot || !format) return null;
  return {
    slot,
    format,
    mime: row.mime,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    version: brandVersion(row.sha256),
    png: row.pngWidth && row.pngHeight ? { width: row.pngWidth, height: row.pngHeight } : null,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ? row.updatedBy.name.trim() || row.updatedBy.email : null,
  };
}

/** The uploaded slots (metadata only). */
export async function loadBrandingState(client: Db = defaultDb): Promise<BrandingState> {
  const rows = await client.brandAsset.findMany({ select: INFO_SELECT });
  const state: BrandingState = { ...EMPTY_BRANDING };
  for (const row of rows) {
    const info = toInfo(row);
    if (info) state[info.slot] = info;
  }
  return state;
}

// ---------- Writes ----------

export type BrandingActor = { staff: { id: string; role: StaffRole }; actor: AuditActor };

export type BrandingWriteOptions = {
  client?: typeof defaultDb;
  /** Called after the commit when something changed (default revalidateTag). */
  revalidate?: (tag: string) => void;
};

export type BrandingWriteResult = { slot: BrandSlot; changed: boolean; branding: BrandingState };

function assertCanManage(by: BrandingActor): void {
  if (!can(by.staff.role, "settings.manage")) throw errors.forbidden(roleForbiddenMessage(by.staff.role));
}

/** "image/png, 23456 bytes, sha256 3f2a9c1b0d4e" (never the bytes). */
export function brandAuditDetail(file: { mime: string; byteSize: number; sha256: string }): string {
  return `${file.mime}, ${file.byteSize} bytes, sha256 ${brandVersion(file.sha256)}`;
}

const auditTarget = (slot: BrandSlot) => ({
  target: `Branding · ${BRANDING_COPY.slots[slot].title}`,
  targetType: "settings",
  targetId: `branding.${slot}`,
});

function afterWrite(slot: BrandSlot, by: BrandingActor, opts: BrandingWriteOptions, event: string): void {
  forgetBrandFile(slot);
  try {
    (opts.revalidate ?? revalidateTag)(STOREFRONT_TAGS.settings);
  } catch (error) {
    // Outside a request (scripts) there is no cache to revalidate; the 5-minute revalidation catches up.
    log.warn("branding_revalidate_failed", { slot, error: error instanceof Error ? error.message : String(error) });
  }
  log.info(event, { slot, by: by.staff.id });
}

/** Stores a processed upload in `slot` (replacing what was there). The same file again changes nothing. */
export async function saveBrandAsset(
  by: BrandingActor,
  slot: BrandSlot,
  asset: ProcessedBrandAsset,
  opts: BrandingWriteOptions = {},
): Promise<BrandingWriteResult> {
  assertCanManage(by);
  const client = opts.client ?? defaultDb;
  const key = BRAND_SLOT_DB[slot];
  const changed = await client.$transaction(async (tx) => {
    const previous = await tx.brandAsset.findUnique({ where: { slot: key }, select: { mime: true, byteSize: true, sha256: true } });
    if (previous?.sha256 === asset.sha256) return false;
    const data = {
      mime: asset.mime,
      bytes: new Uint8Array(asset.bytes),
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      byteSize: asset.byteSize,
      pngBytes: asset.png ? new Uint8Array(asset.png.bytes) : null,
      pngWidth: asset.png?.width ?? null,
      pngHeight: asset.png?.height ?? null,
      updatedById: by.staff.id,
    };
    await tx.brandAsset.upsert({ where: { slot: key }, create: { slot: key, ...data }, update: data });
    await audit(tx, by.actor, {
      action: previous ? BRAND_AUDIT_ACTIONS.replaced : BRAND_AUDIT_ACTIONS.uploaded,
      ...auditTarget(slot),
      detail: previous ? `${brandAuditDetail(asset)} (was ${brandAuditDetail(previous)})` : brandAuditDetail(asset),
    });
    return true;
  });
  if (changed) afterWrite(slot, by, opts, "branding_uploaded");
  return { slot, changed, branding: await loadBrandingState(client) };
}

/** Removes the upload in `slot` (the built-in look returns). Nothing uploaded: changed false, nothing written. */
export async function removeBrandAsset(by: BrandingActor, slot: BrandSlot, opts: BrandingWriteOptions = {}): Promise<BrandingWriteResult> {
  assertCanManage(by);
  const client = opts.client ?? defaultDb;
  const key = BRAND_SLOT_DB[slot];
  const changed = await client.$transaction(async (tx) => {
    const previous = await tx.brandAsset.findUnique({ where: { slot: key }, select: { mime: true, byteSize: true, sha256: true } });
    if (!previous) return false;
    const { count } = await tx.brandAsset.deleteMany({ where: { slot: key } });
    if (count === 0) return false;
    await audit(tx, by.actor, {
      action: BRAND_AUDIT_ACTIONS.removed,
      ...auditTarget(slot),
      detail: `was ${brandAuditDetail(previous)}; the built-in ${slot === "favicon" ? "icon" : "logo"} is back`,
    });
    return true;
  });
  if (changed) afterWrite(slot, by, opts, "branding_removed");
  return { slot, changed, branding: await loadBrandingState(client) };
}

// ---------- Serving ----------

type StoredFile = {
  version: string;
  sha256: string;
  mime: string;
  format: BrandFormat;
  bytes: Buffer;
  png: Buffer | null;
  /** The favicon rendition on an opaque background (made on first request; process.ts appleTouchIcon). */
  apple?: Promise<Buffer>;
};
type CacheEntry = { at: number; file: StoredFile | null };

const FILE_TTL_MS = 30_000;
/** A request for another version re-reads the database at most this often per slot. */
const MISMATCH_RECHECK_MS = 2_000;
const fileCache = new Map<BrandSlot, CacheEntry>();
/** Bumped by every forgetBrandFile: a database read that started before a write never caches its (older) result. */
let cacheGeneration = 0;

/** Drops this process's cached bytes (after a write; tests). */
export function forgetBrandFile(slot?: BrandSlot): void {
  cacheGeneration += 1;
  if (slot) fileCache.delete(slot);
  else fileCache.clear();
}

async function storedFile(client: Db, slot: BrandSlot, wantVersion: string | null): Promise<StoredFile | null> {
  const now = Date.now();
  const hit = fileCache.get(slot);
  if (hit) {
    const age = now - hit.at;
    const matches = !wantVersion || hit.file?.version === wantVersion;
    if (age < FILE_TTL_MS && (matches || age < MISMATCH_RECHECK_MS)) return hit.file;
  }
  const generation = cacheGeneration;
  const row = await client.brandAsset.findUnique({
    where: { slot: BRAND_SLOT_DB[slot] },
    select: { mime: true, sha256: true, bytes: true, pngBytes: true },
  });
  const format = row ? formatFromMime(row.mime) : null;
  const file: StoredFile | null =
    row && format
      ? {
          version: brandVersion(row.sha256),
          sha256: row.sha256,
          mime: row.mime,
          format,
          bytes: Buffer.from(row.bytes),
          png: row.pngBytes ? Buffer.from(row.pngBytes) : null,
        }
      : null;
  if (generation === cacheGeneration) fileCache.set(slot, { at: now, file });
  return file;
}

export type BrandFile = { body: Buffer; contentType: string; format: BrandFormat; version: string; sha256: string };

/** The stored file (or its PNG rendition) for GET /brand/:file, or null when the slot is empty. */
export async function readBrandFile(
  slot: BrandSlot,
  variant: BrandFileVariant,
  wantVersion: string | null,
  client: Db = defaultDb,
): Promise<BrandFile | null> {
  const file = await storedFile(client, slot, wantVersion);
  if (!file) return null;
  const meta = { format: file.format, version: file.version, sha256: file.sha256 };
  if (variant === "original") return { body: file.bytes, contentType: file.mime, ...meta };
  const png = file.png;
  if (!png) return null;
  if (variant === "png") return { body: png, contentType: "image/png", ...meta };
  if (slot !== "favicon") return null;
  file.apple ??= appleIcon(png);
  return { body: await file.apple, contentType: "image/png", ...meta };
}

/** The apple-touch-icon from the favicon rendition; the transparent rendition if sharp fails (logged). */
async function appleIcon(png: Buffer): Promise<Buffer> {
  try {
    // Loaded here only: every page imports this module (lib/branding/server.ts), only this route needs sharp.
    const { appleTouchIcon } = await import("./process");
    return await appleTouchIcon(png);
  } catch (error) {
    log.warn("branding_apple_icon_failed", { error: error instanceof Error ? error.message : String(error) });
    return png;
  }
}

// ---------- PDFs and emails ----------

/** The light logo's PNG rendition for invoice and credit note PDFs, or null (the built-in look). Never throws. */
export async function invoiceLogo(client: Db = defaultDb): Promise<RasterLogo | null> {
  try {
    const row = await client.brandAsset.findUnique({
      where: { slot: BRAND_SLOT_DB["logo-light"] },
      select: { pngBytes: true, pngWidth: true, pngHeight: true },
    });
    if (!row?.pngBytes || !row.pngWidth || !row.pngHeight) return null;
    return { png: Buffer.from(row.pngBytes), width: row.pngWidth, height: row.pngHeight };
  } catch (error) {
    log.warn("invoice_logo_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** The email header logo (absolute rendition URLs on `appUrl`), or null for the built-in one. Never throws. */
export async function emailLogo(client: Db, appUrl: string): Promise<EmailLogo | null> {
  try {
    return emailLogoFrom(await loadBrandingState(client), appUrl, SITE_NAME);
  } catch (error) {
    log.warn("email_logo_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
