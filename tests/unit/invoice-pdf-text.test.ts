/**
 * The invoice PDF's text layer (what copy, search, screen readers and accounting imports read). Manrope ligatures
 * (fi, ff, tt) used to become one glyph with a multi-character ToUnicode entry (`<0066 0069>`), which some readers cut
 * to its first character ("ofice", "Atn", "review-fd-…"). lib/invoice/pdf.tsx turns ligatures off; this renders a real
 * invoice and reads its text back through the embedded ToUnicode maps.
 */
import { inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { buildInvoiceModel, type InvoiceModelInput } from "@/lib/invoice/model";
import { INVOICE_FONT_FEATURES, renderInvoicePdf } from "@/lib/invoice/pdf";

const INPUT: InvoiceModelInput = {
  orderId: "AX-10376",
  status: "PAID",
  createdAt: "2026-10-06T22:32:00.000Z",
  invoice: { number: "AXS/26-27/1181", issuedAt: "2026-10-06T22:33:00.000Z" },
  sac: "997331",
  seller: {
    legalName: "Axiomatic Software Solutions (placeholder)",
    gstin: "27AAAAA0000A1Z5",
    address: "Registered office address (placeholder)",
    city: "Pune",
    state: "Maharashtra",
    pin: "411001",
    sample: true,
  },
  billing: {
    name: "Attn Tiffany Griffith",
    email: "review-fid-paid-5477@example.test",
    phone: "9820012345",
    business: "Affinity Office Supplies",
    address: "12 Fifth Street",
    city: "Pune",
    state: "Maharashtra",
    pin: "411001",
    gstin: "27ABCDE1234F1Z5",
  },
  placeOfSupply: "Maharashtra",
  couponCode: null,
  totals: { subtotalPaise: 499_900, discountPaise: 0, taxablePaise: 499_900, cgstPaise: 44_991, sgstPaise: 44_991, igstPaise: 0, totalPaise: 589_882 },
  items: [
    {
      productName: "Office pack",
      productShortName: null,
      planName: "Annual license",
      kind: "NEW",
      qty: 1,
      unitPricePaise: 499_900,
      discountPaise: 0,
      taxablePaise: 499_900,
      taxPaise: 89_982,
      targetLicenseId: null,
    },
  ],
};

type Pdf = { raw: string; buf: Buffer };

/** Body of every indirect object, by object number. */
function objects({ raw }: Pdf): Map<number, { body: string; start: number }> {
  const out = new Map<number, { body: string; start: number }>();
  for (const m of raw.matchAll(/(\d+) 0 obj\b/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf("endobj", start);
    out.set(Number(m[1]), { body: raw.slice(start, end), start });
  }
  return out;
}

/** Decompressed stream of an object (FlateDecode), or null. */
function streamOf(pdf: Pdf, obj: { body: string; start: number }): string | null {
  const at = obj.body.indexOf("stream");
  if (at < 0) return null;
  let begin = obj.start + at + 6;
  if (pdf.raw[begin] === "\r") begin += 1;
  if (pdf.raw[begin] === "\n") begin += 1;
  const end = pdf.raw.indexOf("endstream", begin);
  try {
    return inflateSync(pdf.buf.subarray(begin, end)).toString("latin1");
  } catch {
    return null;
  }
}

/** ToUnicode entries: glyph code -> destination hex (whitespace kept, so multi-character entries stay visible). */
function parseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[^>]*>)/g)) {
      const lo = parseInt(m[1] ?? "0", 16);
      const target = m[3] ?? "";
      if (target.startsWith("[")) {
        [...target.matchAll(/<([^>]*)>/g)].forEach((d, i) => map.set(lo + i, d[1] ?? ""));
      } else {
        const hi = parseInt(m[2] ?? "0", 16);
        const base = parseInt(target.slice(1, -1).replace(/\s/g, ""), 16);
        for (let c = lo; c <= hi; c++) map.set(c, (base + c - lo).toString(16).padStart(4, "0"));
      }
    }
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([^>]*)>/g)) map.set(parseInt(m[1] ?? "0", 16), m[2] ?? "");
  }
  return map;
}

function hexToText(hex: string): string {
  const clean = hex.replace(/\s/g, "");
  let text = "";
  for (let i = 0; i + 4 <= clean.length; i += 4) text += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  return text;
}

/** Fonts used by the pages (resource name -> ToUnicode map) and the text each TJ/Tj draws, one entry per operator. */
function readText(pdf: Pdf): { cmaps: Map<string, Map<number, string>>; runs: string[] } {
  const objs = objects(pdf);
  const cmaps = new Map<string, Map<number, string>>();
  for (const m of pdf.raw.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const font = objs.get(Number(m[2]));
    const ref = font?.body.match(/\/ToUnicode (\d+) 0 R/);
    const cmapObj = ref ? objs.get(Number(ref[1])) : undefined;
    const cmap = cmapObj ? streamOf(pdf, cmapObj) : null;
    if (m[1] && cmap) cmaps.set(m[1], parseCMap(cmap));
  }
  const runs: string[] = [];
  for (const obj of objs.values()) {
    const content = streamOf(pdf, obj);
    if (!content || !/T[Jj]/.test(content)) continue;
    let font: Map<number, string> | undefined;
    for (const op of content.matchAll(/\/(F\d+) [\d.]+ Tf|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
      if (op[1]) {
        font = cmaps.get(op[1]);
        continue;
      }
      const codes = op[2] !== undefined ? [...op[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1] ?? "").join("") : op[3] ?? "";
      let text = "";
      for (let i = 0; i + 4 <= codes.length; i += 4) text += hexToText(font?.get(parseInt(codes.slice(i, i + 4), 16)) ?? "");
      runs.push(text);
    }
  }
  return { cmaps, runs };
}

describe("invoice PDF text layer", () => {
  let pdf: Pdf;

  beforeAll(async () => {
    const buf = await renderInvoicePdf(buildInvoiceModel(INPUT));
    pdf = { buf, raw: buf.toString("latin1") };
  }, 60_000);

  it("turns ligatures off for the whole document", () => {
    expect(INVOICE_FONT_FEATURES).toEqual({ liga: false, clig: false });
  });

  it("maps every glyph to exactly one character (no ligature glyphs a reader could cut short)", () => {
    const { cmaps } = readText(pdf);
    expect(cmaps.size).toBeGreaterThan(0);
    const multi: string[] = [];
    for (const [font, map] of cmaps) {
      for (const [code, dest] of map) if (dest.replace(/\s/g, "").length !== 4) multi.push(`${font}:${code}->${dest}`);
    }
    expect(multi).toEqual([]);
  });

  it("reads back the words that contain fi, ff, ffi and tt", () => {
    // Runs split where the font or script changes ("12 " | "Fifth Street"), so join them without a separator.
    const text = readText(pdf).runs.join("");
    for (const words of [
      "Registered office address (placeholder)",
      "Attn: Attn Tiffany Griffith",
      "review-fid-paid-5477@example.test",
      "Affinity Office Supplies",
      "12 Fifth Street",
      "Office pack",
      "This is a computer-generated invoice and does not need a signature.",
    ]) {
      expect(text).toContain(words);
    }
  });
});
