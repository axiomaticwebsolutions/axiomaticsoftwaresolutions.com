/**
 * File type from the bytes (magic numbers), never from the client's Content-Type or the file name
 * (docs/security.md "Branding uploads"). Pure.
 */

/** Formats recognised; only png, webp, svg and ico are ever accepted (lib/branding/model.ts BRAND_RULES). */
export type SniffedImage = "png" | "webp" | "svg" | "ico" | "jpeg" | "gif" | "bmp" | "tiff" | "heif" | "pdf";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.length < start + length) return "";
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function isPng(bytes: Uint8Array, offset = 0): boolean {
  return startsWith(bytes, PNG_SIGNATURE, offset);
}

/**
 * SVG: UTF-8 text (an optional BOM) whose first non-blank character is "<" and which contains an `<svg` start tag.
 * UTF-16 and other encodings are not SVG here. Whether it is a well-formed, safe SVG is decided by sanitizeSvg().
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return false;
  }
  const trimmed = text.replace(/^﻿/, "").trimStart();
  return trimmed.startsWith("<") && /<svg[\s/>]/.test(trimmed);
}

/** The image type the bytes start with, or null. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (isPng(bytes)) return "png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 6 && (bytes[4] !== 0 || bytes[5] !== 0)) return "ico";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "gif";
  if (ascii(bytes, 0, 2) === "BM") return "bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (ascii(bytes, 4, 4) === "ftyp") return "heif";
  if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (looksLikeSvg(bytes)) return "svg";
  return null;
}
