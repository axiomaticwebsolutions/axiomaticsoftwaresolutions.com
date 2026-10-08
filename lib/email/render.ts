/**
 * Template rendering: `{{var}}` substitution and the HTML + plain-text bodies (pure).
 *
 * - HTML: the template text and every value are HTML-escaped; newlines inside a paragraph become <br>. Values of
 *   variables named `*_url` that are http(s) URLs become links. Nothing else is linked, so visitor-supplied text
 *   (a lead's message) is never turned into a clickable link by us.
 * - Plain text: no escaping; control characters (other than newlines and tabs) are removed from values.
 * - Subject: values are inserted as text and every run of whitespace (including CR/LF) collapses to one space.
 * - Unknown variables (no value supplied) stay visible as `{{name}}` in development and render blank in production;
 *   their names are returned so callers can log a warning.
 * - Body paragraphs are separated by blank lines. Code-defined blocks go before the closing paragraph (the sign-off)
 *   when the body has at least three paragraphs, otherwise after the body.
 */
import type { EmailLogo } from "@/lib/branding/model";
import type { EmailBlock } from "./defaults";
import {
  buttonHtml,
  codeHtml,
  detailsHtml,
  emailDocumentHtml,
  emailDocumentText,
  escapeHtml,
  linkHtml,
  noteHtml,
  paragraphHtml,
  quoteHtml,
  type EmailFooter,
} from "./layout";

export { escapeHtml };

export type EmailVars = Readonly<Record<string, string | undefined>>;
/** "keep": leave `{{name}}` visible (development); "blank": render nothing (production). */
export type UnknownVarMode = "keep" | "blank";

export const MAX_SUBJECT_LENGTH = 200;
const PREHEADER_LENGTH = 140;

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
// C0 controls except tab and newline, plus DEL. CR is normalised to LF first.
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;
const GREETING_RE = /^(hi|hello|dear)\b/i;

/** Production blanks unknown variables; everything else keeps them visible. Never throws. */
export function defaultUnknownVarMode(): UnknownVarMode {
  return process.env.NODE_ENV === "production" ? "blank" : "keep";
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function cleanValue(value: string): string {
  return normalizeNewlines(value).replace(CONTROL_RE, "");
}

/** True for absolute http(s) URLs (the only URLs we ever link). */
export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Names of the `{{var}}` placeholders in a template, in order of first use. */
export function templateVarNames(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(VAR_RE)) {
    const name = m[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

type FillContext = { vars: EmailVars; mode: UnknownVarMode; unknown: Set<string> };

function lookup(ctx: FillContext, name: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(ctx.vars, name)) return undefined;
  const value = ctx.vars[name];
  return typeof value === "string" ? cleanValue(value) : undefined;
}

function fill(
  template: string,
  ctx: FillContext,
  literal: (text: string) => string,
  value: (name: string, text: string) => string,
): string {
  let out = "";
  let last = 0;
  for (const m of template.matchAll(VAR_RE)) {
    const index = m.index ?? 0;
    out += literal(template.slice(last, index));
    const name = m[1] ?? "";
    const v = lookup(ctx, name);
    if (v === undefined) {
      ctx.unknown.add(name);
      if (ctx.mode === "keep") out += literal(m[0]);
    } else {
      out += value(name, v);
    }
    last = index + m[0].length;
  }
  return out + literal(template.slice(last));
}

const textLiteral = (text: string) => text;
const textValue = (_name: string, text: string) => text;
const htmlLiteral = (text: string) => escapeHtml(text).replace(/\n/g, "<br>");

/** A value as HTML: escaped, newlines as <br>, `*_url` http(s) values as links. */
export function valueHtml(name: string, text: string): string {
  if (name.endsWith("_url") && isHttpUrl(text.trim())) return linkHtml(text.trim());
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function fillTextWith(template: string, ctx: FillContext): string {
  return fill(normalizeNewlines(template), ctx, textLiteral, textValue);
}

function fillHtmlWith(template: string, ctx: FillContext): string {
  return fill(normalizeNewlines(template), ctx, htmlLiteral, valueHtml);
}

function newContext(vars: EmailVars, mode?: UnknownVarMode): FillContext {
  return { vars, mode: mode ?? defaultUnknownVarMode(), unknown: new Set() };
}

/** Plain-text substitution (no escaping). */
export function fillText(template: string, vars: EmailVars, mode?: UnknownVarMode): string {
  return fillTextWith(template, newContext(vars, mode));
}

/** HTML substitution: template text and values escaped, `*_url` values linked. */
export function fillHtml(template: string, vars: EmailVars, mode?: UnknownVarMode): string {
  return fillHtmlWith(template, newContext(vars, mode));
}

/** One header line: whitespace (CR/LF included) collapsed, trimmed, at most MAX_SUBJECT_LENGTH characters. */
export function subjectLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUBJECT_LENGTH ? `${line.slice(0, MAX_SUBJECT_LENGTH - 1).trimEnd()}…` : line;
}

/** Paragraphs separated by blank lines (whitespace-only lines count as blank). */
export function splitParagraphs(body: string): string[] {
  return normalizeNewlines(body)
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

export type RenderEmailInput = {
  /** Subject template. */
  subject: string;
  /** Body template (plain text, paragraphs separated by blank lines). */
  body: string;
  /** Code-defined blocks (lib/email/defaults.ts). */
  blocks: readonly EmailBlock[];
  vars: EmailVars;
  footer: EmailFooter;
  /** Absolute app URL (logo link, footer host). */
  appUrl: string;
  /** The uploaded logo (Admin > Settings > Branding); null or missing = the built-in logo. */
  logo?: EmailLogo | null;
  /** Default: "blank" in production, "keep" elsewhere. */
  unknownVars?: UnknownVarMode;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  /** Placeholders that had no value (names only). */
  unknownVars: string[];
};

type RenderedPart = { html: string; text: string };

function renderBlock(block: EmailBlock, ctx: FillContext): RenderedPart | null {
  switch (block.kind) {
    case "code": {
      const code = lookup(ctx, block.var)?.trim();
      return code ? { html: codeHtml(block.label, code), text: `${block.label}: ${code}` } : null;
    }
    case "button": {
      const url = lookup(ctx, block.urlVar)?.trim();
      return url && isHttpUrl(url) ? { html: buttonHtml(block.label, url), text: `${block.label}: ${url}` } : null;
    }
    case "details": {
      const rows = block.rows.flatMap((row) => {
        const value = lookup(ctx, row.var)?.trim();
        return value ? [{ label: row.label, value, name: row.var }] : [];
      });
      if (rows.length === 0) return null;
      return {
        html: detailsHtml(rows.map((r) => ({ label: r.label, valueHtml: valueHtml(r.name, r.value) }))),
        text: rows.map((r) => `${r.label}: ${r.value.replace(/\n/g, " ")}`).join("\n"),
      };
    }
    case "quote": {
      const value = lookup(ctx, block.var)?.trim();
      return value ? { html: quoteHtml(block.label, valueHtml(block.var, value)), text: `${block.label}:\n${value}` } : null;
    }
    case "note": {
      const html = fillHtmlWith(block.text, ctx);
      const text = fillTextWith(block.text, ctx);
      return text.trim() ? { html: noteHtml(html), text } : null;
    }
  }
}

function preheaderFrom(paragraphTexts: readonly string[], subject: string): string {
  const candidates = paragraphTexts.filter((p, i) => !(i === 0 && paragraphTexts.length > 1 && GREETING_RE.test(p) && p.length <= 80));
  const first = (candidates[0] ?? subject).replace(/\s+/g, " ").trim();
  return first.length > PREHEADER_LENGTH ? `${first.slice(0, PREHEADER_LENGTH - 1).trimEnd()}…` : first;
}

/** Renders subject, HTML document and plain-text alternative. Never throws for missing variables. */
export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const ctx = newContext(input.vars, input.unknownVars);
  const subject = subjectLine(fillTextWith(input.subject, ctx));

  const paragraphs = splitParagraphs(input.body).map((p) => ({ html: fillHtmlWith(p, ctx), text: fillTextWith(p, ctx).trim() }));
  const blocks = input.blocks.map((b) => renderBlock(b, ctx)).filter((b): b is RenderedPart => b !== null);

  const insertAt = paragraphs.length >= 3 ? paragraphs.length - 1 : paragraphs.length;
  const parts: Array<RenderedPart & { kind: "paragraph" | "block" }> = [
    ...paragraphs.slice(0, insertAt).map((p) => ({ ...p, kind: "paragraph" as const })),
    ...blocks.map((b) => ({ ...b, kind: "block" as const })),
    ...paragraphs.slice(insertAt).map((p) => ({ ...p, kind: "paragraph" as const })),
  ];

  const contentHtml = parts.map((p) => (p.kind === "paragraph" ? paragraphHtml(p.html) : p.html)).join("");
  const contentText = parts
    .map((p) => p.text)
    .filter((t) => t.trim() !== "")
    .join("\n\n");

  const html = emailDocumentHtml({
    subject,
    preheader: preheaderFrom(
      paragraphs.map((p) => p.text),
      subject,
    ),
    contentHtml,
    footer: input.footer,
    appUrl: input.appUrl,
    logo: input.logo,
  });
  const text = emailDocumentText({ contentText, footer: input.footer, appUrl: input.appUrl });
  return { subject, html, text, unknownVars: [...ctx.unknown] };
}
