/**
 * SVG uploads (Admin > Settings > Branding; docs/security.md "Branding uploads"). Pure.
 *
 * The file is parsed with a small strict XML parser and REBUILT from an allowlist; nothing of the original markup is
 * passed through as text. In order:
 * 1. Refused outright (422, the Owner sees why): a DOCTYPE or entity declaration (no entity expansion, no XXE),
 *    processing instructions (xml-stylesheet), named entities other than the five XML ones, malformed XML, more than
 *    one root, a root that is not <svg>.
 * 2. Refused anywhere in the tree, even inside elements that would be dropped: <script>, <foreignObject>, elements that
 *    embed other content (<image>, <feImage>, <iframe>, <embed>, <object>, <audio>, <video>, <canvas>, <handler>,
 *    <listener>), event-handler attributes (on*), `javascript:` / `vbscript:` / `data:text/html` in any attribute,
 *    href / xlink:href / src that is not a local "#id" reference, url(...) that is not url(#id), and CSS (in <style>,
 *    style="..." and every other kept attribute, checked as written, comments included) with @import, image-set()
 *    and similar, src(), expression(), -moz-binding, behavior or backslash escape sequences. Every check is a linear
 *    scan (no backtracking regex), so a 1 MB file cannot stall the server.
 * 3. Dropped silently: elements and attributes outside the allowlist (editor metadata such as sodipodi:*, inkscape:*,
 *    <metadata>, animation elements, data-* attributes), comments, namespaced elements and attributes other than
 *    xlink:href and xml:space. <a> and <switch> are unwrapped (their children stay).
 * The root gets the SVG namespace, a viewBox (from width and height when missing) and its intrinsic size in px.
 *
 * Served with "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox" (app/brand/[file]),
 * so even a file opened directly cannot run anything.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";

export const SVG_MESSAGES = {
  malformed: "This SVG isn't valid XML.",
  notSvg: "This file isn't an SVG image.",
  doctype: "SVG files with a DOCTYPE or entity declarations aren't accepted.",
  entity: "The SVG uses an entity that isn't allowed.",
  instruction: "The SVG contains a processing instruction (such as a linked style sheet).",
  script: "The SVG contains a script. Remove it and upload the file again.",
  foreignObject: "The SVG contains embedded HTML (foreignObject).",
  embedded: "The SVG embeds another file (an image, frame or object). Export it as plain shapes, or upload a PNG or WebP.",
  handler: "The SVG contains event handlers (such as onload).",
  javascript: "The SVG contains a javascript: link.",
  external: "The SVG links to another file or website. Only references inside the file (#id) are allowed.",
  css: "The SVG's styles load other files or use features that aren't allowed.",
  size: "The SVG needs a viewBox, or a width and height in pixels.",
  tooComplex: "The SVG is too complex.",
} as const;

export class SvgRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgRejectedError";
  }
}

const reject = (message: string) => new SvgRejectedError(message);

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 20_000;
const MAX_ATTRIBUTES = 200;

type XmlElement = { name: string; attrs: Array<[string, string]>; children: XmlNode[] };
type XmlNode = XmlElement | { text: string };

const isElement = (node: XmlNode): node is XmlElement => "name" in node;

const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const SPACE = new Set([" ", "\t", "\n", "\r"]);

function validXmlChar(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

/** The five XML entities and numeric character references; anything else is refused (there is no DOCTYPE). */
function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&<\s]{0,32})(;?)/g, (_match, body: string, semi: string) => {
    if (!semi) throw reject(SVG_MESSAGES.malformed);
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const m = /^#(x[0-9A-Fa-f]{1,6}|[0-9]{1,7})$/.exec(body);
    if (!m?.[1]) throw reject(SVG_MESSAGES.entity);
    const cp = m[1].startsWith("x") ? parseInt(m[1].slice(1), 16) : parseInt(m[1], 10);
    if (!validXmlChar(cp)) throw reject(SVG_MESSAGES.malformed);
    return String.fromCodePoint(cp);
  });
}

/** Strict, non-validating XML parser for one document element. Throws SvgRejectedError. */
function parseXml(input: string): XmlElement {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(input)) throw reject(SVG_MESSAGES.malformed);
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const n = text.length;
  let i = 0;
  // An XML declaration only at the very start.
  if (text.startsWith("<?xml") && /[\s?]/.test(text.charAt(5))) {
    const end = text.indexOf("?>");
    if (end < 0) throw reject(SVG_MESSAGES.malformed);
    i = end + 2;
  }
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let count = 0;

  while (i < n) {
    const lt = text.indexOf("<", i);
    const stop = lt < 0 ? n : lt;
    if (stop > i) {
      const raw = text.slice(i, stop);
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push({ text: decodeEntities(raw) });
      else if (raw.trim() !== "") throw reject(SVG_MESSAGES.malformed);
    }
    if (lt < 0) break;
    i = lt;

    if (text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      if (close < 0) throw reject(SVG_MESSAGES.malformed);
      i = close + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const parent = stack[stack.length - 1];
      const close = text.indexOf("]]>", i + 9);
      if (!parent || close < 0) throw reject(SVG_MESSAGES.malformed);
      parent.children.push({ text: text.slice(i + 9, close) });
      i = close + 3;
      continue;
    }
    if (text.startsWith("<!", i)) throw reject(SVG_MESSAGES.doctype);
    if (text.startsWith("<?", i)) throw reject(SVG_MESSAGES.instruction);

    if (text.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(text);
      if (!m) throw reject(SVG_MESSAGES.malformed);
      let j = NAME.lastIndex;
      while (j < n && SPACE.has(text.charAt(j))) j++;
      if (text.charAt(j) !== ">") throw reject(SVG_MESSAGES.malformed);
      const open = stack.pop();
      if (!open || open.name !== m[0]) throw reject(SVG_MESSAGES.malformed);
      i = j + 1;
      continue;
    }

    NAME.lastIndex = i + 1;
    const m = NAME.exec(text);
    if (!m) throw reject(SVG_MESSAGES.malformed);
    const el: XmlElement = { name: m[0], attrs: [], children: [] };
    let j = NAME.lastIndex;
    let selfClosing = false;
    for (;;) {
      const before = j;
      while (j < n && SPACE.has(text.charAt(j))) j++;
      if (j >= n) throw reject(SVG_MESSAGES.malformed);
      if (text.charAt(j) === ">") {
        j += 1;
        break;
      }
      if (text.startsWith("/>", j)) {
        j += 2;
        selfClosing = true;
        break;
      }
      // Attributes are separated by whitespace.
      if (j === before) throw reject(SVG_MESSAGES.malformed);
      NAME.lastIndex = j;
      const a = NAME.exec(text);
      if (!a) throw reject(SVG_MESSAGES.malformed);
      j = NAME.lastIndex;
      while (j < n && SPACE.has(text.charAt(j))) j++;
      if (text.charAt(j) !== "=") throw reject(SVG_MESSAGES.malformed);
      j += 1;
      while (j < n && SPACE.has(text.charAt(j))) j++;
      const quote = text.charAt(j);
      if (quote !== '"' && quote !== "'") throw reject(SVG_MESSAGES.malformed);
      const close = text.indexOf(quote, j + 1);
      if (close < 0) throw reject(SVG_MESSAGES.malformed);
      const rawValue = text.slice(j + 1, close);
      if (rawValue.includes("<")) throw reject(SVG_MESSAGES.malformed);
      if (el.attrs.some(([k]) => k === a[0])) throw reject(SVG_MESSAGES.malformed);
      if (el.attrs.length >= MAX_ATTRIBUTES) throw reject(SVG_MESSAGES.tooComplex);
      // XML attribute-value normalisation: literal tabs and line breaks become spaces.
      el.attrs.push([a[0], decodeEntities(rawValue.replace(/[\t\n\r]/g, " "))]);
      j = close + 1;
    }

    count += 1;
    if (count > MAX_ELEMENTS) throw reject(SVG_MESSAGES.tooComplex);
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (root) throw reject(SVG_MESSAGES.malformed);
    else root = el;
    if (!selfClosing) {
      stack.push(el);
      if (stack.length > MAX_DEPTH) throw reject(SVG_MESSAGES.tooComplex);
    }
    i = j;
  }
  if (stack.length > 0 || !root) throw reject(SVG_MESSAGES.malformed);
  return root;
}

// ---------- Policy ----------

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

/** Elements that embed or run other content: the whole file is refused. Compared lower-cased, without a prefix. */
const EMBED_ELEMENTS = words("image feimage iframe embed object audio video canvas handler listener");

const ALLOWED_ELEMENTS = words(`
  svg g defs title desc symbol use path rect circle ellipse line polyline polygon text tspan textPath
  linearGradient radialGradient stop clipPath mask pattern marker filter style
  feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap
  feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode
  feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence
`);

/** Containers whose children are kept without them. */
const UNWRAP_ELEMENTS = words("a switch");

/** Elements whose text content is kept. */
const TEXT_ELEMENTS = words("text tspan textPath title desc style");

const ALLOWED_ATTRIBUTES = words(`
  id class style transform viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry fx fy fr d points
  pathLength offset gradientUnits gradientTransform spreadMethod patternUnits patternContentUnits patternTransform
  clipPathUnits maskUnits maskContentUnits filterUnits primitiveUnits href xlink:href xml:space version media
  fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray
  stroke-dashoffset stroke-opacity opacity clip-path clip-rule mask filter color display visibility overflow
  stop-color stop-opacity font-family font-size font-size-adjust font-weight font-style font-variant font-stretch
  font-kerning letter-spacing word-spacing text-anchor dominant-baseline alignment-baseline baseline-shift
  text-decoration writing-mode direction unicode-bidi isolation mix-blend-mode paint-order vector-effect
  shape-rendering text-rendering image-rendering color-interpolation color-interpolation-filters color-rendering
  flood-color flood-opacity lighting-color marker-start marker-mid marker-end dx dy rotate textLength lengthAdjust
  startOffset method spacing side markerWidth markerHeight markerUnits refX refY orient
  in in2 result stdDeviation mode type values operator k1 k2 k3 k4 radius edgeMode order kernelMatrix
  kernelUnitLength divisor bias targetX targetY preserveAlpha surfaceScale diffuseConstant specularConstant
  specularExponent azimuth elevation pointsAtX pointsAtY pointsAtZ limitingConeAngle scale xChannelSelector
  yChannelSelector baseFrequency numOctaves seed stitchTiles tableValues slope intercept amplitude exponent
`);

const localName = (name: string) => (name.includes(":") ? name.slice(name.indexOf(":") + 1) : name);

function textOf(el: XmlElement): string {
  return el.children.map((c) => (isElement(c) ? textOf(c) : c.text)).join("");
}

const isSpace = (ch: string) => ch !== "" && /\s/.test(ch);

/** A reference inside this file: "#" and a name without quotes, brackets, spaces or backslashes. */
const LOCAL_REF = /^#[^\s'"()\\]*$/;

/**
 * Every url(...) must be a local reference: url(#id), url('#id') or url("#id"). A single forward scan (no regex
 * backtracking, so the work stays linear in the length of the value): an unterminated url(, an unquoted body with a
 * quote, bracket or space in it, or a reference that is not "#..." refuses the file. "url (" with a space is checked
 * too (stricter than CSS).
 */
function checkUrls(value: string): void {
  // Every index below is into `lower` (lower-casing can change the length of non-ASCII text).
  const lower = value.toLowerCase();
  const n = lower.length;
  let from = 0;
  for (;;) {
    const at = lower.indexOf("url", from);
    if (at < 0) return;
    let i = at + 3;
    while (i < n && isSpace(lower.charAt(i))) i++;
    if (lower.charAt(i) !== "(") {
      from = at + 3;
      continue;
    }
    i += 1;
    while (i < n && isSpace(lower.charAt(i))) i++;
    const quote = lower.charAt(i);
    let ref: string;
    let end: number;
    if (quote === '"' || quote === "'") {
      const close = lower.indexOf(quote, i + 1);
      if (close < 0) throw reject(SVG_MESSAGES.external);
      ref = lower.slice(i + 1, close);
      end = close + 1;
      while (end < n && isSpace(lower.charAt(end))) end++;
      if (lower.charAt(end) !== ")") throw reject(SVG_MESSAGES.external);
    } else {
      end = lower.indexOf(")", i);
      if (end < 0) throw reject(SVG_MESSAGES.external);
      ref = lower.slice(i, end);
    }
    // "#id" only: no quote, bracket or space inside, so the span skipped here can never hide another url( (a quoted
    // "url('#a" inside a CSS string would otherwise run to a later quote and swallow a real url(...) on the way).
    if (!LOCAL_REF.test(ref.trim())) throw reject(SVG_MESSAGES.external);
    from = end + 1;
  }
}

/**
 * CSS: a <style> element's text, a style attribute, and every other attribute value (presentation attributes such as
 * fill, filter or mask are CSS values too). Checked as written, comments and strings included: a comment cannot join
 * tokens in CSS, so nothing a browser or librsvg would load can hide from these checks (a url( or @import inside a
 * comment is refused as well). Backslash escapes are refused everywhere, so no keyword can be spelled another way.
 */
function checkCss(css: string): void {
  const plain = css.toLowerCase();
  if (plain.includes("\\")) throw reject(SVG_MESSAGES.css);
  if (/@import|expression\s*\(|-moz-binding|behavior\s*:|(?:image-set|image|cross-fade|element|src)\s*\(/.test(plain)) {
    throw reject(SVG_MESSAGES.css);
  }
  if (/(?:java|vb)script:/.test(plain.replace(/\s+/g, ""))) throw reject(SVG_MESSAGES.javascript);
  checkUrls(css);
}

/** Pass 1: refuse dangerous content anywhere in the tree (before anything is dropped). */
function inspect(el: XmlElement): void {
  const lower = localName(el.name).toLowerCase();
  if (lower === "script") throw reject(SVG_MESSAGES.script);
  if (lower === "foreignobject") throw reject(SVG_MESSAGES.foreignObject);
  if (EMBED_ELEMENTS.has(lower)) throw reject(SVG_MESSAGES.embedded);
  for (const [name, value] of el.attrs) {
    const attr = localName(name.toLowerCase());
    if (attr.startsWith("on")) throw reject(SVG_MESSAGES.handler);
    const compact = value.replace(/[\u0000- \u007F-\u009F]+/g, "").toLowerCase();
    if (/(?:java|vb)script:/.test(compact) || compact.includes("data:text/html")) throw reject(SVG_MESSAGES.javascript);
    if ((attr === "href" || attr === "src") && !value.trim().startsWith("#")) throw reject(SVG_MESSAGES.external);
    // Every attribute that can reach the output (style and the presentation attributes are CSS) gets the full CSS
    // check: escapes, @import, url() and friends. Attributes that are always dropped (editor metadata such as
    // inkscape:export-filename, which often holds a Windows path with backslashes) are still checked for url().
    if (ALLOWED_ATTRIBUTES.has(name)) checkCss(value);
    else checkUrls(value);
  }
  if (lower === "style") checkCss(textOf(el));
  for (const child of el.children) if (isElement(child)) inspect(child);
}

// ---------- Serialisation ----------

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}

type SerializeContext = { xlink: boolean };

function keptAttributes(el: XmlElement, ctx: SerializeContext): Array<[string, string]> {
  const kept: Array<[string, string]> = [];
  for (const [name, value] of el.attrs) {
    if (!ALLOWED_ATTRIBUTES.has(name)) continue;
    if (el.name === "style" && name === "type" && value.trim().toLowerCase() !== "text/css") continue;
    if (name === "xlink:href") ctx.xlink = true;
    kept.push([name, value]);
  }
  return kept;
}

const attrsText = (attrs: Array<[string, string]>) => attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");

function serializeChildren(el: XmlElement, keepText: boolean, ctx: SerializeContext): string {
  let out = "";
  for (const child of el.children) {
    if (isElement(child)) out += serializeElement(child, ctx);
    else if (keepText) out += escapeText(child.text);
  }
  return out;
}

function serializeElement(el: XmlElement, ctx: SerializeContext): string {
  if (el.name.includes(":")) return "";
  if (UNWRAP_ELEMENTS.has(el.name)) return serializeChildren(el, false, ctx);
  if (!ALLOWED_ELEMENTS.has(el.name)) return "";
  const body = serializeChildren(el, TEXT_ELEMENTS.has(el.name), ctx);
  const attrs = attrsText(keptAttributes(el, ctx));
  return body === "" ? `<${el.name}${attrs}/>` : `<${el.name}${attrs}>${body}</${el.name}>`;
}

// ---------- Root size ----------

const UNIT_PX: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

/** A length in px ("120", "120px", "32mm"); percentages, em and ex give null. */
export function svgLengthPx(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*\+?((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/.exec(value);
  if (!m?.[1]) return null;
  const px = parseFloat(m[1]) * (UNIT_PX[m[2] ?? "px"] ?? 1);
  return Number.isFinite(px) && px > 0 ? px : null;
}

export function parseViewBox(value: string | undefined): [number, number, number, number] | null {
  if (value === undefined) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return w > 0 && h > 0 ? [x, y, w, h] : null;
}

const MAX_INTRINSIC = 1_000_000;
const num = (v: number) => String(Math.round(v * 1000) / 1000);

/** Largest rounding change of the proportions svgStoredSize accepts (0.2 %: under half a pixel at the sizes shown). */
const STORED_RATIO_TOLERANCE = 0.002;

/**
 * Whole-number width and height with the SVG's proportions (BrandAsset stores integers, and every <img> of the logo
 * takes its width and height from them, so wrong proportions would shift the layout once the file loads). The file's
 * own size when rounding keeps the proportions; otherwise scaled by 10, 100, ... until it does: a viewBox of
 * "0 0 1 0.2" is stored as 10 x 2 (5:1), not 1 x 1, and "0 0 120.5 30.25" as 1205 x 303.
 */
export function svgStoredSize(width: number, height: number): { width: number; height: number } {
  const ratio = width / height;
  for (let scale = 1; scale <= MAX_INTRINSIC; scale *= 10) {
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (w > MAX_INTRINSIC || h > MAX_INTRINSIC) break;
    if (w >= 1 && h >= 1 && Math.abs(w / h / ratio - 1) <= STORED_RATIO_TOLERANCE) return { width: w, height: h };
  }
  // Extreme proportions: the longer side becomes MAX_INTRINSIC.
  const s = MAX_INTRINSIC / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export type SanitizedSvg = {
  /** The rebuilt document (UTF-8 text, no XML declaration). */
  svg: string;
  /** Intrinsic size in px (proportions for display; an SVG scales). */
  width: number;
  height: number;
  /** The same document drawn at width x height px (for the PNG rendition). */
  render: (width: number, height: number) => string;
};

/** Parses, checks and rebuilds an SVG. Throws SvgRejectedError with a message for the Owner. */
export function sanitizeSvg(input: string | Uint8Array): SanitizedSvg {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw reject(SVG_MESSAGES.notSvg);
    }
  }
  const root = parseXml(text);
  if (root.name !== "svg") throw reject(SVG_MESSAGES.notSvg);
  const xmlns = root.attrs.find(([k]) => k === "xmlns")?.[1];
  if (xmlns !== undefined && xmlns !== SVG_NS) throw reject(SVG_MESSAGES.notSvg);
  inspect(root);

  const attr = (name: string) => root.attrs.find(([k]) => k === name)?.[1];
  const viewBox = parseViewBox(attr("viewBox"));
  const w = svgLengthPx(attr("width"));
  const h = svgLengthPx(attr("height"));
  if (!viewBox && !(w && h)) throw reject(SVG_MESSAGES.size);
  const ratio = viewBox ? viewBox[2] / viewBox[3] : (w as number) / (h as number);
  const width = Math.min(MAX_INTRINSIC, w ?? (h ? h * ratio : (viewBox as number[])[2] as number));
  const height = Math.min(MAX_INTRINSIC, h ?? (w ? w / ratio : (viewBox as number[])[3] as number));
  if (!(width > 0 && height > 0)) throw reject(SVG_MESSAGES.size);

  const ctx: SerializeContext = { xlink: false };
  const body = serializeChildren(root, false, ctx);
  const rootAttrs = keptAttributes(root, ctx).filter(([k]) => k !== "width" && k !== "height" && k !== "viewBox");
  const box = viewBox ? viewBox.map(num).join(" ") : `0 0 ${num(width)} ${num(height)}`;
  const open = (pxWidth: number, pxHeight: number) =>
    `<svg xmlns="${SVG_NS}"${ctx.xlink ? ` xmlns:xlink="${XLINK_NS}"` : ""} width="${num(pxWidth)}" height="${num(pxHeight)}" viewBox="${box}"${attrsText(rootAttrs)}>`;
  const svg = `${open(width, height)}${body}</svg>`;
  return { svg, width, height, render: (rw, rh) => `${open(rw, rh)}${body}</svg>` };
}
