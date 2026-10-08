/**
 * Branding uploads, pure parts (docs/security.md "Branding uploads"): type sniffing from magic bytes and the SVG
 * sanitizer (strict parse, refusal of scripts, handlers, foreignObject, javascript: and external URLs, DOCTYPE and
 * entities; allowlist rebuild; root size and viewBox), plus the ICO container checks.
 */
import { describe, expect, it } from "vitest";
import { decodeIcoBmp, icoBmpLength, ICO_MESSAGES, largestIcoEntry, parseIco, writeIco } from "@/lib/branding/ico";
import { sniffImage } from "@/lib/branding/sniff";
import { sanitizeSvg, svgStoredSize, SVG_MESSAGES, SvgRejectedError } from "@/lib/branding/svg";

const enc = (text: string) => new TextEncoder().encode(text);
const SVG = (body: string, attrs = 'viewBox="0 0 100 20"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

function rejected(input: string): string {
  try {
    sanitizeSvg(input);
  } catch (error) {
    if (error instanceof SvgRejectedError) return error.message;
    throw error;
  }
  throw new Error(`accepted: ${input}`);
}

describe("sniffImage", () => {
  it("recognises the accepted types from their bytes, whatever the name or declared type", () => {
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("png");
    expect(sniffImage(enc("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("webp");
    expect(sniffImage(Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe("ico");
    expect(sniffImage(enc('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("svg");
    expect(sniffImage(enc("﻿  <svg viewBox='0 0 1 1'></svg>"))).toBe("svg");
  });

  it("names the types it refuses and returns null for anything else", () => {
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(enc("GIF89a...."))).toBe("gif");
    expect(sniffImage(enc("BM......"))).toBe("bmp");
    expect(sniffImage(enc("%PDF-1.7"))).toBe("pdf");
    expect(sniffImage(Uint8Array.from([0, 0, 2, 0, 1, 0]))).toBeNull(); // a cursor, not an icon
    expect(sniffImage(Uint8Array.from([0, 0, 1, 0, 0, 0]))).toBeNull(); // an icon with no images
    expect(sniffImage(enc("<html><body>hi</body></html>"))).toBeNull();
    expect(sniffImage(enc("hello <svg>"))).toBeNull(); // must start with markup
    expect(sniffImage(Uint8Array.from([0xff, 0xfe, 0x3c, 0x00, 0x73, 0x00]))).toBeNull(); // UTF-16
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});

describe("sanitizeSvg: accepted files are rebuilt from the allowlist", () => {
  it("keeps shapes, gradients, local references and styles; drops editor metadata, comments and unknown attributes", () => {
    const input =
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Inkscape -->\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:sodipodi="http://sodipodi" ' +
      'xmlns:inkscape="http://inkscape" viewBox="0 0 120 30" data-name="Layer 1" version="1.1">' +
      '<sodipodi:namedview id="nv" inkscape:zoom="2"/><metadata><rdf>x</rdf></metadata>' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#6355CF"/></linearGradient>' +
      "<style>.a{fill:url(#g)}</style></defs>" +
      '<g inkscape:label="Logo" class="a"><path d="M0 0h10v10z" fill="url(#g)" data-id="x" aria-label="mark"/>' +
      '<use xlink:href="#p"/><text x="1" y="2">Axi &amp; Co</text></g>' +
      '<a href="#top"><circle cx="5" cy="5" r="2"/></a><animate attributeName="opacity" to="0"/></svg>';
    const out = sanitizeSvg(input);
    expect(out.svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="30" viewBox="0 0 120 30" version="1.1">' +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#6355CF"/></linearGradient><style>.a{fill:url(#g)}</style></defs>' +
        '<g class="a"><path d="M0 0h10v10z" fill="url(#g)"/><use xlink:href="#p"/><text x="1" y="2">Axi &amp; Co</text></g>' +
        '<circle cx="5" cy="5" r="2"/></svg>',
    );
    expect([out.width, out.height]).toEqual([120, 30]);
    // The output is stable: sanitizing it again changes nothing.
    expect(sanitizeSvg(out.svg).svg).toBe(out.svg);
  });

  it("derives the intrinsic size from width/height (with units) or the viewBox, and adds a missing viewBox", () => {
    expect(sanitizeSvg(SVG("", 'width="240" height="60"')).svg).toContain('width="240" height="60" viewBox="0 0 240 60"');
    const mm = sanitizeSvg(SVG("", 'width="25.4mm" height="12.7mm"'));
    expect([mm.width, mm.height]).toEqual([96, 48]);
    const one = sanitizeSvg(SVG("", 'viewBox="0 0 400 100" width="200"'));
    expect([one.width, one.height]).toEqual([200, 50]);
    const pct = sanitizeSvg(SVG("", 'viewBox="0,0,50,50" width="100%"'));
    expect([pct.width, pct.height]).toEqual([50, 50]);
    expect(rejected(SVG("", 'width="100%"'))).toBe(SVG_MESSAGES.size);
    expect(rejected(SVG("", 'viewBox="0 0 0 10"'))).toBe(SVG_MESSAGES.size);
  });

  it("draws at a requested size for the PNG rendition", () => {
    const out = sanitizeSvg(SVG('<rect width="100" height="20"/>'));
    expect(out.render(640, 128)).toContain('width="640" height="128" viewBox="0 0 100 20"');
    expect(out.render(640, 128)).toContain('<rect width="100" height="20"/>');
  });
});

describe("sanitizeSvg: refusals", () => {
  it("refuses scripts, in any case and inside elements that would be dropped", () => {
    expect(rejected(SVG("<script>alert(1)</script>"))).toBe(SVG_MESSAGES.script);
    expect(rejected(SVG("<SCRIPT>alert(1)</SCRIPT>"))).toBe(SVG_MESSAGES.script);
    expect(rejected(SVG('<metadata><svg:script xmlns:svg="http://www.w3.org/2000/svg">x</svg:script></metadata>'))).toBe(SVG_MESSAGES.script);
    expect(rejected(SVG("<g><script><![CDATA[alert(1)]]></script></g>"))).toBe(SVG_MESSAGES.script);
  });

  it("refuses event-handler attributes (onload on the root, onclick deeper, any case)", () => {
    expect(rejected('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"/>')).toBe(SVG_MESSAGES.handler);
    expect(rejected(SVG('<g><rect onClick="alert(1)"/></g>'))).toBe(SVG_MESSAGES.handler);
    expect(rejected(SVG('<animate onbegin="alert(1)"/>'))).toBe(SVG_MESSAGES.handler);
  });

  it("refuses foreignObject and embedded files", () => {
    expect(rejected(SVG('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'))).toBe(SVG_MESSAGES.foreignObject);
    expect(rejected(SVG('<image href="data:image/png;base64,AAAA"/>'))).toBe(SVG_MESSAGES.embedded);
    expect(rejected(SVG('<filter id="f"><feImage href="#x"/></filter>'))).toBe(SVG_MESSAGES.embedded);
    expect(rejected(SVG('<iframe src="https://evil.example"/>'))).toBe(SVG_MESSAGES.embedded);
  });

  it("refuses javascript: however it is spelled", () => {
    expect(rejected(SVG('<a href="javascript:alert(1)"><rect/></a>'))).toBe(SVG_MESSAGES.javascript);
    expect(rejected(SVG('<a xlink:href=" jAvAsCrIpT:alert(1)"><rect/></a>'))).toBe(SVG_MESSAGES.javascript);
    expect(rejected(SVG('<a href="java&#x09;script:alert(1)"><rect/></a>'))).toBe(SVG_MESSAGES.javascript);
    expect(rejected(SVG('<a href="&#106;avascript:alert(1)"><rect/></a>'))).toBe(SVG_MESSAGES.javascript);
    expect(rejected(SVG('<set attributeName="href" to="javascript:alert(1)"/>'))).toBe(SVG_MESSAGES.javascript);
  });

  it("refuses external URLs in href, src, url() and CSS", () => {
    expect(rejected(SVG('<use href="https://evil.example/sprite.svg#a"/>'))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG('<use xlink:href="//evil.example/s.svg#a"/>'))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG('<use href="other.svg#a"/>'))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG('<rect fill="url(https://evil.example/p.svg#g)"/>'))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG('<rect style="fill:url( \'/x.svg#g\' )"/>'))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG("<style>rect{fill:url(/**/https://evil.example/x)}</style>"))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG('<style>@import "https://evil.example/x.css";</style>'))).toBe(SVG_MESSAGES.css);
    expect(rejected(SVG("<style>rect{background:image-set('https://evil.example/x.png' 1x)}</style>"))).toBe(SVG_MESSAGES.css);
    expect(rejected(SVG("<style>rect{fill:\\75 rl(x)}</style>"))).toBe(SVG_MESSAGES.css);
  });

  it("refuses DOCTYPE, entity declarations, unknown entities and processing instructions", () => {
    expect(rejected(`<!DOCTYPE svg [<!ENTITY x "boom">]>${SVG("&x;")}`)).toBe(SVG_MESSAGES.doctype);
    expect(rejected(`<?xml version="1.0"?><!DOCTYPE svg SYSTEM "file:///etc/passwd">${SVG("")}`)).toBe(SVG_MESSAGES.doctype);
    expect(rejected(SVG("<text>&nbsp;</text>"))).toBe(SVG_MESSAGES.entity);
    expect(rejected(`<?xml-stylesheet href="https://evil.example/x.css"?>${SVG("")}`)).toBe(SVG_MESSAGES.instruction);
    expect(rejected(SVG('<g><?php echo 1 ?></g>'))).toBe(SVG_MESSAGES.instruction);
  });

  it("refuses malformed XML and other documents", () => {
    expect(rejected(SVG("<g>"))).toBe(SVG_MESSAGES.malformed);
    expect(rejected(SVG("<g></h></g>"))).toBe(SVG_MESSAGES.malformed);
    expect(rejected(`${SVG("")}<svg/>`)).toBe(SVG_MESSAGES.malformed);
    expect(rejected(SVG('<rect x="1"y="2"/>'))).toBe(SVG_MESSAGES.malformed);
    expect(rejected(SVG('<rect x="1" x="2"/>'))).toBe(SVG_MESSAGES.malformed);
    expect(rejected(SVG("<text>a & b</text>"))).toBe(SVG_MESSAGES.malformed);
    expect(rejected("<html><body/></html>")).toBe(SVG_MESSAGES.notSvg);
    expect(rejected('<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 1 1"/>')).toBe(SVG_MESSAGES.notSvg);
    expect(rejected(`<svg xmlns="http://www.w3.org/2000/svg">${"<g>".repeat(70)}${"</g>".repeat(70)}</svg>`)).toBe(SVG_MESSAGES.tooComplex);
    expect(() => sanitizeSvg(Uint8Array.from([0x3c, 0x73, 0xff, 0xfe]))).toThrow(SvgRejectedError);
  });
});

/** A minimal ICO: one 32-bit BMP image of `size` px, opaque red with a transparent top-left pixel. */
function bmpIco(size: number): Uint8Array {
  const pixels = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const image = 40 + pixels + maskStride * size;
  const out = new Uint8Array(6 + 16 + image);
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  out[6] = size % 256;
  out[7] = size % 256;
  view.setUint16(6 + 4, 1, true);
  view.setUint16(6 + 6, 32, true);
  view.setUint32(6 + 8, image, true);
  view.setUint32(6 + 12, 22, true);
  const h = 22;
  view.setUint32(h, 40, true);
  view.setInt32(h + 4, size, true);
  view.setInt32(h + 8, size * 2, true);
  view.setUint16(h + 12, 1, true);
  view.setUint16(h + 14, 32, true);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = h + 40 + (y * size + x) * 4;
      out[at + 2] = 255; // red (BGRA)
      // Bottom-up rows: row size-1 in the file is the top of the image.
      out[at + 3] = y === size - 1 && x === 0 ? 0 : 255;
    }
  }
  return out;
}

describe("ICO container", () => {
  it("lists the images and decodes a 32-bit entry to RGBA, top row first", () => {
    const ico = bmpIco(48);
    const entries = parseIco(ico);
    expect(entries).toEqual([expect.objectContaining({ width: 48, height: 48, kind: "bmp", bitCount: 32 })]);
    const decoded = decodeIcoBmp(ico, largestIcoEntry(entries));
    expect(decoded && [decoded.width, decoded.height, decoded.rgba.length]).toEqual([48, 48, 48 * 48 * 4]);
    expect(Array.from(decoded?.rgba.subarray(0, 8) ?? [])).toEqual([255, 0, 0, 0, 255, 0, 0, 255]);
  });

  it("refuses bad headers, out-of-file images and non-square images", () => {
    const ico = bmpIco(48);
    expect(() => parseIco(ico.subarray(0, 30))).toThrow(ICO_MESSAGES.invalid);
    const cursor = Uint8Array.from(ico);
    cursor[2] = 2;
    expect(() => parseIco(cursor)).toThrow(ICO_MESSAGES.invalid);
    const outside = Uint8Array.from(ico);
    new DataView(outside.buffer).setUint32(6 + 12, ico.length, true);
    expect(() => parseIco(outside)).toThrow(ICO_MESSAGES.invalid);
    const garbage = Uint8Array.from(ico);
    new DataView(garbage.buffer).setUint32(22, 12, true); // not a BITMAPINFOHEADER or PNG
    expect(() => parseIco(garbage)).toThrow(ICO_MESSAGES.invalid);
    const wide = Uint8Array.from(ico);
    new DataView(wide.buffer).setInt32(22 + 4, 32, true); // 32 wide, 48 tall
    expect(() => parseIco(wide)).toThrow(ICO_MESSAGES.invalid);
  });
});

describe("sanitizeSvg: CSS that hides a URL (review fixes)", () => {
  const BS = String.fromCharCode(92);

  it("refuses CSS escapes in presentation attributes, not only in style", () => {
    expect(rejected(SVG(`<rect fill="${BS}75 rl(https://evil.example/p.svg#g)"/>`))).toBe(SVG_MESSAGES.css);
    expect(rejected(SVG(`<rect filter="u${BS}rl(https://evil.example/f.svg#f)"/>`))).toBe(SVG_MESSAGES.css);
    expect(rejected(SVG(`<rect mask="${BS}000075rl(https://evil.example/m.svg#m)"/>`))).toBe(SVG_MESSAGES.css);
  });

  it("checks CSS as written: a '/*' inside a string cannot hide url() or @import", () => {
    expect(rejected(SVG('<style>a{font-family:"/*"} rect{fill:url(https://evil.example/p.svg#g)} b{font-family:"*/"}</style>'))).toBe(
      SVG_MESSAGES.external,
    );
    expect(rejected(SVG('<style>@font-face{font-family:"/*";src:url(https://evil.example/f.woff)} b{font-family:"*/"}</style>'))).toBe(
      SVG_MESSAGES.external,
    );
    expect(rejected(SVG(`<rect style="font-family:'/*';fill:url(https://evil.example/p.svg#g);x:'*/'"/>`))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG('<style>a{font-family:"/*"} @import "https://evil.example/x.css"; b{font-family:"*/"}</style>'))).toBe(SVG_MESSAGES.css);
    expect(rejected(SVG("<style>/* url(https://evil.example/x) */ rect{fill:red}</style>"))).toBe(SVG_MESSAGES.external);
  });

  it("does not let a quoted url( inside a CSS string swallow a real one", () => {
    expect(rejected(SVG(`<style>a{font-family:"url('#a"} rect{fill:url(https://evil.example/x)} b{font-family:"')"}</style>`))).toBe(
      SVG_MESSAGES.external,
    );
    expect(rejected(SVG('<rect fill="url(#a url(https://evil.example/x))"/>'))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG('<rect fill="url(#a"/>'))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG(`<rect fill="url('#a)"/>`))).toBe(SVG_MESSAGES.external);
    expect(rejected(SVG('<style>rect{fill:src("https://evil.example/x")}</style>'))).toBe(SVG_MESSAGES.css);
  });

  it("still accepts local references, comments and quoted forms", () => {
    const out = sanitizeSvg(
      SVG(`<defs><linearGradient id="g"/></defs><style>/* brand */ .a{fill:url(#g)} .b{fill:url( "#g" )}</style><rect class="a" fill="url('#g')" style="stroke:url(#g)"/>`),
    );
    expect(out.svg).toContain("<style>/* brand */ .a{fill:url(#g)} .b{fill:url( \"#g\" )}</style>");
    expect(out.svg).toContain(`fill="url('#g')"`);
    // Editor metadata with a Windows path (dropped from the output) is not a CSS escape.
    const inkscape = sanitizeSvg(SVG(`<rect width="1" height="1" inkscape:export-filename="C:${BS}logos${BS}a.png" xmlns:inkscape="x"/>`));
    expect(inkscape.svg).not.toContain("export-filename");
  });

  it("refuses 1 MB of unterminated url( or /* in well under a second (no backtracking)", () => {
    for (const body of [`<rect fill="${"url(".repeat(250_000)}"/>`, `<style>${"url(".repeat(250_000)}</style>`, `<style>${"url('".repeat(200_000)}</style>`]) {
      const started = performance.now();
      expect(rejected(SVG(body))).toBe(SVG_MESSAGES.external);
      expect(performance.now() - started).toBeLessThan(1000);
    }
    const started = performance.now();
    sanitizeSvg(SVG(`<style>${"/* ".repeat(330_000)}</style>`));
    sanitizeSvg(SVG(`<style>${".a{fill:url(#g)}".repeat(60_000)}</style>`));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("svgStoredSize", () => {
  it("keeps whole-number sizes and scales fractional ones until the proportions hold", () => {
    expect(svgStoredSize(240, 60)).toEqual({ width: 240, height: 60 });
    expect(svgStoredSize(96, 48)).toEqual({ width: 96, height: 48 });
    expect(svgStoredSize(1, 0.2)).toEqual({ width: 10, height: 2 });
    expect(svgStoredSize(2.5, 0.5)).toEqual({ width: 25, height: 5 });
    const odd = svgStoredSize(120.5, 30.25);
    expect(odd).toEqual({ width: 1205, height: 303 });
    expect(Math.abs(odd.width / odd.height / (120.5 / 30.25) - 1)).toBeLessThan(0.002);
    expect(svgStoredSize(1_000_000, 0.001)).toEqual({ width: 1_000_000, height: 1 });
  });
});

describe("ICO rebuild helpers", () => {
  it("writes a new ICO with recomputed offsets that parses to the same images", () => {
    const source = bmpIco(48);
    const [entry] = parseIco(source);
    if (!entry) throw new Error("no entry");
    const data = source.subarray(entry.offset, entry.offset + icoBmpLength(source, entry));
    const rebuilt = writeIco([
      { width: 48, height: 48, colorCount: entry.colorCount, planes: entry.planes, bitCount: entry.bitCount, data },
      { width: 48, height: 48, colorCount: 0, planes: 1, bitCount: 32, data },
    ]);
    expect(rebuilt.length).toBe(6 + 32 + 2 * data.length);
    const entries = parseIco(rebuilt);
    expect(entries.map((e) => [e.offset, e.size, e.kind])).toEqual([
      [38, data.length, "bmp"],
      [38 + data.length, data.length, "bmp"],
    ]);
  });

  it("measures a BMP entry without trailing bytes inside its declared size", () => {
    const ico = bmpIco(48);
    const padded = new Uint8Array(ico.length + 100);
    padded.set(ico);
    new DataView(padded.buffer).setUint32(6 + 8, ico.length - 22 + 100, true);
    const [entry] = parseIco(padded);
    if (!entry) throw new Error("no entry");
    expect(entry.size).toBe(ico.length - 22 + 100);
    expect(icoBmpLength(padded, entry)).toBe(40 + 48 * 48 * 4 + 8 * 48);
  });

  it("refuses an ICO whose images add up to more than 64 x 256 x 256 px", () => {
    const huge = Uint8Array.from(bmpIco(48));
    const view = new DataView(huge.buffer);
    view.setInt32(22 + 4, 1024, true);
    view.setInt32(22 + 8, 2048, true);
    // One 1024 px image is within the budget; the same directory entry 5 times is not.
    expect(parseIco(huge)[0]?.width).toBe(1024);
    const many = new Uint8Array(6 + 16 * 5 + (huge.length - 22));
    const mv = new DataView(many.buffer);
    mv.setUint16(2, 1, true);
    mv.setUint16(4, 5, true);
    for (let k = 0; k < 5; k++) {
      many.set(huge.subarray(6, 22), 6 + 16 * k);
      mv.setUint32(6 + 16 * k + 12, 6 + 16 * 5, true);
    }
    many.set(huge.subarray(22), 6 + 16 * 5);
    expect(() => parseIco(many)).toThrow(ICO_MESSAGES.tooLarge);
  });
});
