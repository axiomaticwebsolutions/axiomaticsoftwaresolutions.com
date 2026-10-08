/**
 * Admin > Settings > Branding (settings.manage = Owner; docs/api.md "Branding"). `:slot` is `logo-light`, `logo-dark`
 * or `favicon`; anything else is 404 before the body is read.
 *
 * PUT /api/admin/settings/branding/:slot with the image file as the raw body (Content-Type application/octet-stream or
 * image/*, else 415) -> { slot, changed, branding }. In order: a Content-Length over the slot's limit is refused before
 * reading (422 `validation_failed`, fieldErrors.file), 30 uploads per hour per Owner (429), the body is read up to the
 * limit (422 past it), then lib/branding/process.ts decides from the bytes (type sniffed, raster re-encoded with sharp,
 * SVG rebuilt from an allowlist, ICO validated, size rules) with any problem as a 422 on `file`. Saved with an audit row
 * (slot, type, size, SHA-256 prefix) and the storefront cache revalidated. The same file again: changed false.
 *
 * DELETE /api/admin/settings/branding/:slot -> { slot, changed, branding }: back to the built-in look (audited);
 * nothing uploaded: changed false, nothing written. Any body is ignored.
 */
import { adminRoute, type AdminParams } from "@/lib/admin/http";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { BRAND_MESSAGES, BRAND_RULES, isBrandSlot, type BrandSlot } from "@/lib/branding/model";
import { BrandUploadError, processBrandUpload, type ProcessedBrandAsset } from "@/lib/branding/process";
import { removeBrandAsset, saveBrandAsset } from "@/lib/branding/store";
import { db } from "@/lib/db";
import { ApiError, errors, json, readRawBody } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slotParam(params: AdminParams): BrandSlot {
  const slot = params.slot;
  if (!isBrandSlot(slot)) throw errors.notFound("Branding slot");
  return slot;
}

/** The file itself as the body: application/octet-stream or any image/* type (the type is sniffed from the bytes). */
const UPLOAD_MEDIA = /^(?:application\/octet-stream|image\/[a-z0-9.+-]+)$/;

export const PUT = adminRoute<{ slot: string }>("settings.manage", async ({ req, params, staff, actor }) => {
  const slot = slotParam(params);
  const maxBytes = BRAND_RULES[slot].maxBytes;
  const media = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!UPLOAD_MEDIA.test(media)) throw new ApiError(415, "unsupported_media_type", BRAND_MESSAGES.bodyType);
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw errors.validation({ file: BRAND_MESSAGES.tooLarge(slot) });
  enforce(await hit(db, RATE_LIMITS.brandUpload(staff.id)));

  let bytes: Uint8Array;
  try {
    bytes = await readRawBody(req, maxBytes);
  } catch (error) {
    if (error instanceof ApiError && error.code === "payload_too_large") throw errors.validation({ file: BRAND_MESSAGES.tooLarge(slot) });
    throw error;
  }
  let asset: ProcessedBrandAsset;
  try {
    asset = await processBrandUpload(slot, bytes);
  } catch (error) {
    if (error instanceof BrandUploadError) throw errors.validation({ file: error.message });
    throw error;
  }
  return json(await saveBrandAsset({ staff, actor }, slot, asset));
});

export const DELETE = adminRoute<{ slot: string }>("settings.manage", async ({ params, staff, actor }) => {
  const slot = slotParam(params);
  return json(await removeBrandAsset({ staff, actor }, slot));
});
