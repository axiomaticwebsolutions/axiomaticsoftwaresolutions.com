/**
 * Branding upload processing (lib/branding/process.ts, sharp): type from the bytes, size limits, raster re-encoding
 * that drops metadata and keeps transparency, minimum and maximum dimensions, the square favicon, SVG sanitizing and
 * its PNG rendition, ICO validation and its apple-touch-icon rendition; and the invoice PDF with the uploaded logo.
 */
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BRAND_MESSAGES, type BrandSlot } from "@/lib/branding/model";
import { parseIco } from "@/lib/branding/ico";
import { appleTouchIcon, BrandUploadError, processBrandUpload } from "@/lib/branding/process";
import { SVG_MESSAGES } from "@/lib/branding/svg";
import { buildInvoiceModel, type InvoiceModelInput } from "@/lib/invoice/model";
import { renderInvoicePdf } from "@/lib/invoice/pdf";

const TRANSLUCENT = { r: 99, g: 85, b: 207, alpha: 0.5 };

function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: TRANSLUCENT } }).png().toBuffer();
}

/** Inserts a PNG chunk right after IHDR (metadata a re-encode must drop). */
function withChunk(file: Buffer, type: string, data: string): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data, "latin1")]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  const afterIhdr = 8 + 8 + 13 + 4;
  return Buffer.concat([file.subarray(0, afterIhdr), length, body, crc, file.subarray(afterIhdr)]);
}

/** An ICO with one PNG image (`gap` bytes between the directory and the image, `tail` after it). */
function icoOf(image: Buffer, size: number, gap = Buffer.alloc(0), tail = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = size % 256;
  header[7] = size % 256;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(image.length, 14);
  header.writeUInt32LE(22 + gap.length, 18);
  return Buffer.concat([header, gap, image, tail]);
}

/** An ICO with one PNG image of `size` px. */
async function pngIco(size: number): Promise<Buffer> {
  return icoOf(await png(size, size), size);
}

async function refusal(slot: BrandSlot, bytes: Uint8Array): Promise<string> {
  try {
    await processBrandUpload(slot, bytes);
  } catch (error) {
    if (error instanceof BrandUploadError) return error.message;
    throw error;
  }
  throw new Error("accepted");
}

describe("raster logos", () => {
  it("re-encodes a PNG: metadata dropped, alpha kept, size kept, rendition at most 160 px tall, hash of the stored bytes", async () => {
    const input = withChunk(withChunk(await png(800, 200), "tEXt", "Comment\u0000secret-author-note"), "eXIf", "MM\u0000*secret-camera");
    expect(input.includes("secret-author-note")).toBe(true);
    const out = await processBrandUpload("logo-light", input);
    expect(out).toMatchObject({ format: "png", mime: "image/png", width: 800, height: 200, byteSize: out.bytes.length });
    expect(out.bytes.includes("secret-author-note")).toBe(false);
    expect(out.bytes.includes("secret-camera")).toBe(false);
    expect(out.sha256).toBe(createHash("sha256").update(out.bytes).digest("hex"));
    const meta = await sharp(out.bytes).metadata();
    expect([meta.format, meta.hasAlpha]).toEqual(["png", true]);
    expect(out.png && [out.png.width, out.png.height]).toEqual([640, 160]);
    expect((await sharp(out.png?.bytes).metadata()).hasAlpha).toBe(true);
  });

  it("keeps WebP as (lossless) WebP and never enlarges a small rendition", async () => {
    const webp = await sharp({ create: { width: 300, height: 60, channels: 4, background: TRANSLUCENT } }).webp().toBuffer();
    const out = await processBrandUpload("logo-dark", webp);
    expect(out).toMatchObject({ format: "webp", mime: "image/webp", width: 300, height: 60 });
    expect((await sharp(out.bytes).metadata()).format).toBe("webp");
    expect(out.png && [out.png.width, out.png.height]).toEqual([300, 60]);
  });

  it("enforces the minimum and maximum sizes", async () => {
    expect(await refusal("logo-light", await png(150, 40))).toBe(BRAND_MESSAGES.tooSmall("logo-light"));
    expect(await refusal("logo-light", await png(400, 10))).toBe(BRAND_MESSAGES.tooSmall("logo-light"));
    expect(await refusal("logo-light", await png(6000, 100))).toBe(BRAND_MESSAGES.tooBig);
  });
});

describe("refusals before decoding", () => {
  it("refuses empty and oversized files by their byte count", async () => {
    expect(await refusal("logo-light", new Uint8Array(0))).toBe(BRAND_MESSAGES.empty);
    expect(await refusal("logo-light", new Uint8Array(1024 * 1024 + 1))).toBe("The file is larger than 1 MB.");
    expect(await refusal("favicon", new Uint8Array(256 * 1024 + 1))).toBe("The file is larger than 256 KB.");
  });

  it("decides the type from the bytes: other images and non-images are refused whatever they are called", async () => {
    const jpeg = await sharp({ create: { width: 400, height: 100, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
    expect(await refusal("logo-light", jpeg)).toBe("Upload a PNG, SVG or WebP file.");
    const gif = await sharp({ create: { width: 400, height: 100, channels: 4, background: TRANSLUCENT } }).gif().toBuffer();
    expect(await refusal("logo-light", gif)).toBe("Upload a PNG, SVG or WebP file.");
    expect(await refusal("logo-light", await pngIco(64))).toBe("Upload a PNG, SVG or WebP file.");
    const webp = await sharp({ create: { width: 64, height: 64, channels: 4, background: TRANSLUCENT } }).webp().toBuffer();
    expect(await refusal("favicon", webp)).toBe("Upload a PNG, SVG or ICO file.");
    expect(await refusal("logo-light", new TextEncoder().encode("MZ\u0090\u0000 not an image"))).toBe("This file isn't a PNG, SVG or WebP image.");
    expect(await refusal("logo-light", new TextEncoder().encode("<html><script>alert(1)</script></html>"))).toBe("This file isn't a PNG, SVG or WebP image.");
  });

  it("refuses a damaged PNG and a PNG header that claims a huge image", async () => {
    const whole = await png(800, 200);
    expect(await refusal("logo-light", whole.subarray(0, 60))).toBe(BRAND_MESSAGES.damaged);
    const bomb = Buffer.from(whole);
    bomb.writeUInt32BE(100_000, 16);
    bomb.writeUInt32BE(100_000, 20);
    expect([BRAND_MESSAGES.tooBig, BRAND_MESSAGES.damaged]).toContain(await refusal("logo-light", bomb));
  });
});

describe("SVG", () => {
  const svg = (body: string, attrs = 'viewBox="0 0 100 20"') => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`);

  it("stores the sanitized SVG and draws a PNG rendition 160 px tall", async () => {
    const out = await processBrandUpload("logo-light", svg('<!-- c --><rect width="100" height="20" fill="#6355CF"/>'));
    expect(out).toMatchObject({ format: "svg", mime: "image/svg+xml", width: 100, height: 20 });
    expect(out.bytes.toString("utf8")).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20" viewBox="0 0 100 20"><rect width="100" height="20" fill="#6355CF"/></svg>');
    expect(out.png && [out.png.width, out.png.height]).toEqual([800, 160]);
    expect((await sharp(out.png?.bytes).metadata()).format).toBe("png");
  });

  it("refuses unsafe SVGs with the sanitizer's message", async () => {
    expect(await refusal("logo-light", svg("<script>alert(1)</script>"))).toBe(SVG_MESSAGES.script);
    expect(await refusal("logo-light", svg('<use href="https://evil.example/a.svg#x"/>'))).toBe(SVG_MESSAGES.external);
    expect(await refusal("favicon", svg('<rect width="1" height="1"/>', 'viewBox="0 0 2 1"'))).toBe(BRAND_MESSAGES.notSquare);
  });

  it("stores the size as whole numbers with the SVG's exact proportions (no layout shift for small user units)", async () => {
    const tiny = await processBrandUpload("logo-light", svg('<rect width="1" height="0.2"/>', 'viewBox="0 0 1 0.2"'));
    expect([tiny.width, tiny.height]).toEqual([10, 2]);
    expect(tiny.png && [tiny.png.width, tiny.png.height]).toEqual([800, 160]);
    const odd = await processBrandUpload("logo-light", svg('<rect width="2.5" height="0.5"/>', 'viewBox="0 0 2.5 0.5"'));
    expect([odd.width, odd.height]).toEqual([25, 5]);
  });

  it("makes a square favicon rendition", async () => {
    const out = await processBrandUpload("favicon", svg('<circle cx="8" cy="8" r="8"/>', 'viewBox="0 0 16 16"'));
    expect(out.png && [out.png.width, out.png.height]).toEqual([180, 180]);
  });
});

describe("favicons", () => {
  it("accepts a square PNG of at least 48 px and refuses smaller or non-square ones", async () => {
    const out = await processBrandUpload("favicon", await png(64, 64));
    expect(out).toMatchObject({ format: "png", width: 64, height: 64 });
    expect(out.png && [out.png.width, out.png.height]).toEqual([180, 180]);
    expect(await refusal("favicon", await png(32, 32))).toBe(BRAND_MESSAGES.tooSmall("favicon"));
    expect(await refusal("favicon", await png(64, 48))).toBe(BRAND_MESSAGES.notSquare);
  });

  it("rebuilds an ICO from its images and renders its largest image as the 180 px PNG", async () => {
    const ico = await pngIco(64);
    const out = await processBrandUpload("favicon", ico);
    expect(out).toMatchObject({ format: "ico", mime: "image/x-icon", width: 64, height: 64 });
    expect(parseIco(out.bytes).map((e) => [e.width, e.height, e.kind, e.offset, e.offset + e.size])).toEqual([[64, 64, "png", 22, out.bytes.length]]);
    expect(out.sha256).toBe(createHash("sha256").update(out.bytes).digest("hex"));
    expect(out.png && [out.png.width, out.png.height]).toEqual([180, 180]);
    expect(await refusal("favicon", await pngIco(32))).toBe(BRAND_MESSAGES.tooSmall("favicon"));
    const broken = Buffer.from(ico);
    broken.writeUInt32LE(ico.length, 18);
    expect(await refusal("favicon", broken)).toBe("This ICO file is damaged or isn't an icon.");
  });
});

describe("favicon hardening", () => {
  it("drops bytes between and after the ICO's images and metadata chunks inside its PNG images", async () => {
    const image = withChunk(withChunk(await png(64, 64), "tEXt", "Author\u0000secret-author-note"), "eXIf", "MM\u0000*secret-camera");
    const ico = icoOf(image, 64, Buffer.from("GAP-PAYLOAD"), Buffer.from("<html><script>alert(1)</script></html>PK\u0003\u0004"));
    const out = await processBrandUpload("favicon", ico);
    const text = out.bytes.toString("latin1");
    for (const hidden of ["GAP-PAYLOAD", "<script>", "PK\u0003\u0004", "secret-author-note", "secret-camera", "tEXt", "eXIf"]) {
      expect(text, hidden).not.toContain(hidden);
    }
    const [entry] = parseIco(out.bytes);
    expect(entry && [entry.offset, entry.offset + entry.size]).toEqual([22, out.bytes.length]);
    const meta = await sharp(out.bytes.subarray(22)).metadata();
    expect([meta.format, meta.width, meta.hasAlpha]).toEqual(["png", 64, true]);
  });

  it("flattens the favicon rendition for apple-touch-icon (iOS draws transparent pixels black), keeping the tab icon transparent", async () => {
    const out = await processBrandUpload("favicon", await png(64, 64));
    const rendition = out.png?.bytes ?? Buffer.alloc(0);
    expect((await sharp(rendition).metadata()).hasAlpha).toBe(true);
    const apple = await sharp(await appleTouchIcon(rendition)).metadata();
    expect([apple.width, apple.height, apple.hasAlpha]).toEqual([180, 180, false]);
  });
});

describe("invoice PDF with the uploaded logo", () => {
  const INPUT: InvoiceModelInput = {
    orderId: "AX-10376",
    status: "PAID",
    createdAt: "2026-10-06T22:32:00.000Z",
    invoice: { number: "AXS/26-27/1181", issuedAt: "2026-10-06T22:33:00.000Z" },
    sac: "997331",
    seller: { legalName: "Seller", gstin: "27AAAAA0000A1Z5", address: "Office", city: "Pune", state: "Maharashtra", pin: "411001", sample: false },
    billing: { name: "Buyer", email: "b@example.test", phone: "", business: "", address: "1 Road", city: "Pune", state: "Maharashtra", pin: "411001", gstin: "" },
    placeOfSupply: "Maharashtra",
    couponCode: null,
    totals: { subtotalPaise: 100_000, discountPaise: 0, taxablePaise: 100_000, cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0, totalPaise: 118_000 },
    items: [
      { productName: "Office pack", productShortName: null, planName: "Annual license", kind: "NEW", qty: 1, unitPricePaise: 100_000, discountPaise: 0, taxablePaise: 100_000, taxPaise: 18_000, targetLicenseId: null },
    ],
  };

  it("draws the PNG rendition in the header instead of the built-in mark", async () => {
    const model = buildInvoiceModel(INPUT);
    const plain = (await renderInvoicePdf(model)).toString("latin1");
    expect(plain).not.toContain("/Subtype /Image");
    const logo = await png(640, 160);
    const branded = (await renderInvoicePdf(model, { logo: { png: logo, width: 640, height: 160 } })).toString("latin1");
    expect(branded.startsWith("%PDF-")).toBe(true);
    expect(branded).toContain("/Subtype /Image");
  }, 60_000);
});
