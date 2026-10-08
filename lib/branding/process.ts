/**
 * Branding upload processing (Admin > Settings > Branding; docs/security.md "Branding uploads"). Server-only (sharp).
 *
 * Never trusts the client's type or file name: the type comes from the bytes (lib/branding/sniff.ts) and must be one
 * the slot accepts (BRAND_RULES). Then:
 * - PNG and WebP are decoded with sharp (pixel limit BRAND_MAX_PIXELS, errors fail the upload), auto-rotated and
 *   re-encoded in the same format (PNG, lossless WebP), which drops every metadata chunk (EXIF, XMP, ICC text, comments)
 *   and keeps the alpha channel; only the first frame of an animation is kept.
 * - SVG is rebuilt from an allowlist (lib/branding/svg.ts) and must draw in sharp (librsvg).
 * - ICO is validated (lib/branding/ico.ts) and rebuilt from its images only: PNG images re-encoded (no metadata), BMP
 *   images cut to the bytes they need; anything between or after the images is dropped.
 * Then the size rules (minimums, square favicon, at most BRAND_MAX_SIDE px), and a PNG rendition: logos fit in
 * LOGO_PNG_MAX (emails, PDFs), the favicon becomes FAVICON_PNG_SIZE square with its transparency (a PNG fallback icon;
 * appleTouchIcon flattens it for apple-touch-icon). Anything wrong is a BrandUploadError whose message the route
 * returns as a 422 field error on `file`.
 */
import "server-only";
import { createHash } from "node:crypto";
import sharp, { type Metadata, type OutputInfo, type Sharp } from "sharp";
import { decodeIcoBmp, icoBmpLength, IcoError, largestIcoEntry, parseIco, writeIco, type IcoEntry, type IcoImage } from "./ico";
import {
  BRAND_MAX_PIXELS,
  BRAND_MAX_SIDE,
  BRAND_MESSAGES,
  BRAND_MIME,
  BRAND_RULES,
  FAVICON_PNG_SIZE,
  fitHeight,
  LOGO_PNG_MAX,
  type BrandFormat,
  type BrandSlot,
} from "./model";
import { sniffImage } from "./sniff";
import { sanitizeSvg, svgStoredSize, SvgRejectedError } from "./svg";

export class BrandUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandUploadError";
  }
}

export type BrandPng = { bytes: Buffer; width: number; height: number };

export type ProcessedBrandAsset = {
  format: BrandFormat;
  mime: string;
  /** What the site stores and serves. */
  bytes: Buffer;
  /** Hex SHA-256 of `bytes`. */
  sha256: string;
  width: number;
  height: number;
  byteSize: number;
  png: BrandPng | null;
};

const SHARP_INPUT = { limitInputPixels: BRAND_MAX_PIXELS, failOn: "error", animated: false } as const;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkDimensions(slot: BrandSlot, width: number, height: number, raster: boolean): void {
  const rules = BRAND_RULES[slot];
  if (rules.square && Math.abs(width / height - 1) > 0.01) throw new BrandUploadError(BRAND_MESSAGES.notSquare);
  if (!raster) return;
  if (width > BRAND_MAX_SIDE || height > BRAND_MAX_SIDE) throw new BrandUploadError(BRAND_MESSAGES.tooBig);
  if (width < rules.minWidth || height < rules.minHeight) throw new BrandUploadError(BRAND_MESSAGES.tooSmall(slot));
}

/** The PNG rendition of a decodable image (`input` is anything sharp reads). */
async function rendition(slot: BrandSlot, input: Sharp): Promise<BrandPng> {
  const resized =
    slot === "favicon"
      ? input.resize(FAVICON_PNG_SIZE, FAVICON_PNG_SIZE, { fit: "contain", background: TRANSPARENT })
      : input.resize({ width: LOGO_PNG_MAX.width, height: LOGO_PNG_MAX.height, fit: "inside", withoutEnlargement: true });
  const { data, info } = await resized.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

async function processRaster(slot: BrandSlot, format: "png" | "webp", input: Uint8Array): Promise<Omit<ProcessedBrandAsset, "sha256" | "byteSize" | "mime">> {
  let meta: Metadata;
  try {
    meta = await sharp(input, SHARP_INPUT).metadata();
  } catch {
    throw new BrandUploadError(BRAND_MESSAGES.damaged);
  }
  if (meta.format !== format) throw new BrandUploadError(BRAND_MESSAGES.damaged);
  // Size checks on the upright image before any decoding work.
  const upright = meta.autoOrient ?? { width: meta.width, height: meta.height };
  if (!upright.width || !upright.height) throw new BrandUploadError(BRAND_MESSAGES.damaged);
  checkDimensions(slot, upright.width, upright.height, true);
  let encoded: { data: Buffer; info: OutputInfo };
  try {
    const pipeline = sharp(input, SHARP_INPUT).rotate();
    encoded = await (format === "png"
      ? pipeline.png({ compressionLevel: 9 })
      : pipeline.webp({ lossless: true, effort: 4 })
    ).toBuffer({ resolveWithObject: true });
  } catch {
    throw new BrandUploadError(BRAND_MESSAGES.damaged);
  }
  const png = await rendition(slot, sharp(encoded.data, SHARP_INPUT));
  return { format, bytes: encoded.data, width: encoded.info.width, height: encoded.info.height, png };
}

async function processSvg(slot: BrandSlot, input: Uint8Array): Promise<Omit<ProcessedBrandAsset, "sha256" | "byteSize" | "mime">> {
  let clean: ReturnType<typeof sanitizeSvg>;
  try {
    clean = sanitizeSvg(input);
  } catch (error) {
    if (error instanceof SvgRejectedError) throw new BrandUploadError(error.message);
    throw error;
  }
  checkDimensions(slot, clean.width, clean.height, false);
  const bytes = Buffer.from(clean.svg, "utf8");
  if (bytes.length > BRAND_RULES[slot].maxBytes) throw new BrandUploadError(BRAND_MESSAGES.tooLarge(slot));
  // Draw it at the rendition size (the root's width and height set the raster size; the viewBox scales the content).
  const target =
    slot === "favicon"
      ? { width: FAVICON_PNG_SIZE, height: FAVICON_PNG_SIZE }
      : fitHeight({ width: clean.width, height: clean.height }, LOGO_PNG_MAX.height, LOGO_PNG_MAX.width);
  let png: BrandPng;
  try {
    const drawn = sharp(Buffer.from(clean.render(target.width, target.height), "utf8"), SHARP_INPUT);
    const { data, info } = await (slot === "favicon"
      ? drawn.resize(FAVICON_PNG_SIZE, FAVICON_PNG_SIZE, { fit: "contain", background: TRANSPARENT })
      : drawn
    )
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    png = { bytes: data, width: info.width, height: info.height };
  } catch {
    throw new BrandUploadError(BRAND_MESSAGES.damaged);
  }
  // Whole numbers with the true proportions (pages size the <img> from them; see svgStoredSize).
  const stored = svgStoredSize(clean.width, clean.height);
  return { format: "svg", bytes, width: stored.width, height: stored.height, png };
}

/**
 * Rebuilds an ICO from its validated images only (lib/branding/ico.ts writeIco): PNG images are decoded and re-encoded
 * (no metadata chunks), BMP images keep exactly the bytes they need. Bytes between or after the images are dropped.
 */
async function rebuildIco(input: Uint8Array, entries: readonly IcoEntry[]): Promise<Buffer> {
  const images: IcoImage[] = [];
  for (const entry of entries) {
    if (entry.kind === "png") {
      let encoded: { data: Buffer; info: OutputInfo };
      try {
        encoded = await sharp(input.subarray(entry.offset, entry.offset + entry.size), SHARP_INPUT)
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true });
      } catch {
        throw new BrandUploadError(BRAND_MESSAGES.damaged);
      }
      if (encoded.info.width !== entry.width || encoded.info.height !== entry.height) throw new BrandUploadError(BRAND_MESSAGES.damaged);
      images.push({ width: entry.width, height: entry.height, colorCount: 0, planes: 1, bitCount: 32, data: encoded.data });
    } else {
      const data = input.subarray(entry.offset, entry.offset + icoBmpLength(input, entry));
      images.push({ width: entry.width, height: entry.height, colorCount: entry.colorCount, planes: entry.planes, bitCount: entry.bitCount, data });
    }
  }
  return Buffer.from(writeIco(images));
}

async function processIco(slot: BrandSlot, input: Uint8Array): Promise<Omit<ProcessedBrandAsset, "sha256" | "byteSize" | "mime">> {
  let entries: IcoEntry[];
  try {
    entries = parseIco(input);
  } catch (error) {
    if (error instanceof IcoError) throw new BrandUploadError(error.message);
    throw error;
  }
  const first = largestIcoEntry(entries);
  checkDimensions(slot, first.width, first.height, true);
  const bytes = await rebuildIco(input, entries);
  let largest: IcoEntry;
  try {
    largest = largestIcoEntry(parseIco(bytes));
  } catch {
    throw new BrandUploadError(BRAND_MESSAGES.damaged);
  }
  let png: BrandPng | null = null;
  if (largest.kind === "png") {
    try {
      png = await rendition(slot, sharp(bytes.subarray(largest.offset, largest.offset + largest.size), SHARP_INPUT));
    } catch {
      throw new BrandUploadError(BRAND_MESSAGES.damaged);
    }
  } else {
    const decoded = decodeIcoBmp(bytes, largest);
    if (decoded) {
      png = await rendition(slot, sharp(decoded.rgba, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }));
    }
  }
  return { format: "ico", bytes, width: largest.width, height: largest.height, png };
}

/** Background of the apple-touch-icon (iOS draws transparent pixels of a home-screen icon black). */
const APPLE_TOUCH_BACKGROUND = "#ffffff";

/**
 * The favicon's PNG rendition flattened onto an opaque background, for apple-touch-icon (GET
 * /brand/favicon-apple.png). The stored rendition keeps its transparency for browser tabs.
 */
export async function appleTouchIcon(png: Uint8Array): Promise<Buffer> {
  return sharp(png, SHARP_INPUT).flatten({ background: APPLE_TOUCH_BACKGROUND }).png({ compressionLevel: 9 }).toBuffer();
}

/** Validates and cleans an upload for `slot`. Throws BrandUploadError (shown under the slot as a 422 field error). */
export async function processBrandUpload(slot: BrandSlot, input: Uint8Array): Promise<ProcessedBrandAsset> {
  const rules = BRAND_RULES[slot];
  if (input.length === 0) throw new BrandUploadError(BRAND_MESSAGES.empty);
  if (input.length > rules.maxBytes) throw new BrandUploadError(BRAND_MESSAGES.tooLarge(slot));
  const sniffed = sniffImage(input);
  if (!sniffed) throw new BrandUploadError(BRAND_MESSAGES.notImage(slot));
  if (!(rules.formats as readonly string[]).includes(sniffed)) throw new BrandUploadError(BRAND_MESSAGES.wrongType(slot));
  const format = sniffed as BrandFormat;
  const result =
    format === "svg" ? await processSvg(slot, input) : format === "ico" ? await processIco(slot, input) : await processRaster(slot, format, input);
  return { ...result, mime: BRAND_MIME[result.format], sha256: sha256Hex(result.bytes), byteSize: result.bytes.length };
}
