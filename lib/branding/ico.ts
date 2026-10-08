/**
 * ICO favicons (Admin > Settings > Branding). Pure: validates the container (header, directory, every image inside
 * the file, PNG or BMP data, a pixel budget), measures BMP entries (icoBmpLength), writes a new ICO from validated
 * images (writeIco) and decodes 32- and 24-bit BMP entries to RGBA for the 180 px PNG rendition. The stored file is
 * always REBUILT (lib/branding/process.ts): only the images themselves are kept, PNG entries re-encoded without
 * metadata, so bytes between or after the images (a polyglot, comments) never reach the site.
 */
import { isPng } from "./sniff";

export const ICO_MESSAGES = {
  invalid: "This ICO file is damaged or isn't an icon.",
  notSquare: "Every image in the ICO file must be square.",
  tooLarge: "The ICO file holds too many large images. Keep the sizes up to 256 x 256 px.",
} as const;

/** All images of one ICO together (sum of width x height): 64 images of 256 x 256 px. */
const MAX_TOTAL_PIXELS = 64 * 256 * 256;

export class IcoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcoError";
  }
}

export type IcoEntry = {
  width: number;
  height: number;
  /** Directory fields kept when the file is rebuilt. */
  colorCount: number;
  planes: number;
  bitCount: number;
  offset: number;
  size: number;
  kind: "png" | "bmp";
};

const MAX_ENTRIES = 64;
const BITMAPINFOHEADER = 40;

function u16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)) + (b[at + 3] ?? 0) * 0x1000000;
}

function i32(b: Uint8Array, at: number): number {
  const v = u32(b, at);
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

function u32be(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) * 0x1000000 + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));
}

/** The images of an ICO file. Throws IcoError for anything that is not a well-formed icon. */
export function parseIco(bytes: Uint8Array): IcoEntry[] {
  if (bytes.length < 6 || u16(bytes, 0) !== 0 || u16(bytes, 2) !== 1) throw new IcoError(ICO_MESSAGES.invalid);
  const count = u16(bytes, 4);
  if (count < 1 || count > MAX_ENTRIES) throw new IcoError(ICO_MESSAGES.invalid);
  const directoryEnd = 6 + 16 * count;
  if (bytes.length < directoryEnd) throw new IcoError(ICO_MESSAGES.invalid);
  const entries: IcoEntry[] = [];
  for (let k = 0; k < count; k++) {
    const at = 6 + 16 * k;
    const size = u32(bytes, at + 8);
    const offset = u32(bytes, at + 12);
    if (size < 8 || offset < directoryEnd || offset + size > bytes.length) throw new IcoError(ICO_MESSAGES.invalid);
    let width = bytes[at] || 256;
    let height = bytes[at + 1] || 256;
    const bitCount = u16(bytes, at + 6);
    let kind: IcoEntry["kind"];
    if (isPng(bytes, offset)) {
      // The PNG's own IHDR is the truth (the directory bytes cannot say more than 256).
      if (size < 24 || String.fromCharCode(...bytes.subarray(offset + 12, offset + 16)) !== "IHDR") throw new IcoError(ICO_MESSAGES.invalid);
      width = u32be(bytes, offset + 16);
      height = u32be(bytes, offset + 20);
      kind = "png";
    } else if (u32(bytes, offset) === BITMAPINFOHEADER && size >= BITMAPINFOHEADER) {
      const bmpWidth = i32(bytes, offset + 4);
      const bmpHeight = i32(bytes, offset + 8);
      // The BMP height covers the colour data and the AND mask (twice the icon height).
      if (bmpWidth <= 0 || bmpWidth > 1024 || Math.abs(bmpHeight) !== bmpWidth * 2) throw new IcoError(ICO_MESSAGES.invalid);
      width = bmpWidth;
      height = bmpWidth;
      kind = "bmp";
    } else {
      throw new IcoError(ICO_MESSAGES.invalid);
    }
    if (!(width > 0 && height > 0) || width > 1024 || height > 1024) throw new IcoError(ICO_MESSAGES.invalid);
    if (width !== height) throw new IcoError(ICO_MESSAGES.notSquare);
    entries.push({ width, height, colorCount: bytes[at + 2] ?? 0, planes: u16(bytes, at + 4), bitCount, offset, size, kind });
  }
  if (entries.reduce((sum, e) => sum + e.width * e.height, 0) > MAX_TOTAL_PIXELS) throw new IcoError(ICO_MESSAGES.tooLarge);
  return entries;
}

/**
 * The bytes a BMP entry needs: header, colour table or bit masks, colour data and AND mask (at most its declared
 * size). Unusual layouts (compressed, odd bit depths) keep their declared size.
 */
export function icoBmpLength(bytes: Uint8Array, entry: IcoEntry): number {
  if (entry.kind !== "bmp") return entry.size;
  const header = entry.offset;
  const headerSize = u32(bytes, header);
  const bpp = u16(bytes, header + 14);
  const compression = u32(bytes, header + 16);
  if (![1, 4, 8, 16, 24, 32].includes(bpp) || (compression !== 0 && compression !== 3)) return entry.size;
  const colorsUsed = u32(bytes, header + 32);
  const colors = bpp <= 8 ? colorsUsed || 2 ** bpp : colorsUsed;
  const masks = compression === 3 ? 12 : 0;
  const stride = Math.ceil((entry.width * bpp) / 32) * 4;
  const maskStride = Math.ceil(entry.width / 32) * 4;
  const needed = headerSize + masks + colors * 4 + (stride + maskStride) * entry.height;
  return Math.min(entry.size, needed);
}

/** One image of a new ICO file (writeIco). */
export type IcoImage = { width: number; height: number; colorCount: number; planes: number; bitCount: number; data: Uint8Array };

/** A new ICO file: header, directory and the images back to back, nothing else. */
export function writeIco(images: readonly IcoImage[]): Uint8Array {
  const directoryEnd = 6 + 16 * images.length;
  const out = new Uint8Array(directoryEnd + images.reduce((sum, image) => sum + image.data.length, 0));
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, images.length, true);
  let offset = directoryEnd;
  images.forEach((image, k) => {
    const at = 6 + 16 * k;
    out[at] = image.width >= 256 ? 0 : image.width;
    out[at + 1] = image.height >= 256 ? 0 : image.height;
    out[at + 2] = image.colorCount & 0xff;
    view.setUint16(at + 4, image.planes, true);
    view.setUint16(at + 6, image.bitCount, true);
    view.setUint32(at + 8, image.data.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(image.data, offset);
    offset += image.data.length;
  });
  return out;
}

/** The largest image (a PNG wins a tie). */
export function largestIcoEntry(entries: readonly IcoEntry[]): IcoEntry {
  const sorted = [...entries].sort((a, b) => b.width * b.height - a.width * a.height || (a.kind === "png" ? -1 : b.kind === "png" ? 1 : 0));
  const first = sorted[0];
  if (!first) throw new IcoError(ICO_MESSAGES.invalid);
  return first;
}

/**
 * A 32- or 24-bit BMP entry as RGBA (top row first), or null for other bit depths (no rendition then). 32-bit images
 * use their alpha channel, or the AND mask when every alpha byte is 0; 24-bit images use the AND mask.
 */
export function decodeIcoBmp(bytes: Uint8Array, entry: IcoEntry): { width: number; height: number; rgba: Uint8Array } | null {
  if (entry.kind !== "bmp") return null;
  const header = entry.offset;
  const bpp = u16(bytes, header + 14);
  const compression = u32(bytes, header + 16);
  if ((bpp !== 32 && bpp !== 24) || compression !== 0) return null;
  const w = entry.width;
  const h = entry.height;
  const bottomUp = i32(bytes, header + 8) > 0;
  const pixels = header + u32(bytes, header);
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const maskStride = Math.ceil(w / 32) * 4;
  const maskStart = pixels + stride * h;
  const hasMask = maskStart + maskStride * h <= entry.offset + entry.size;
  if (pixels + stride * h > entry.offset + entry.size) return null;
  const rgba = new Uint8Array(w * h * 4);
  let alphaSeen = false;
  for (let y = 0; y < h; y++) {
    const srcRow = bottomUp ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = pixels + srcRow * stride + x * (bpp / 8);
      const d = (y * w + x) * 4;
      rgba[d] = bytes[s + 2] ?? 0;
      rgba[d + 1] = bytes[s + 1] ?? 0;
      rgba[d + 2] = bytes[s] ?? 0;
      const a = bpp === 32 ? (bytes[s + 3] ?? 0) : 255;
      if (bpp === 32 && a !== 0) alphaSeen = true;
      rgba[d + 3] = a;
    }
  }
  if (bpp === 24 || !alphaSeen) {
    if (!hasMask) {
      if (bpp === 32) for (let p = 3; p < rgba.length; p += 4) rgba[p] = 255;
      return { width: w, height: h, rgba };
    }
    for (let y = 0; y < h; y++) {
      const srcRow = bottomUp ? h - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const byte = bytes[maskStart + srcRow * maskStride + (x >> 3)] ?? 0;
        const transparent = (byte >> (7 - (x & 7))) & 1;
        rgba[(y * w + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  }
  return { width: w, height: h, rgba };
}
