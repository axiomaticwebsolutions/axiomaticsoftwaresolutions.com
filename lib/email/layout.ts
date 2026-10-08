/**
 * Branded email layout: table-based HTML with inline styles only (email clients drop <style> blocks and flexbox),
 * no web fonts, colours from lib/design/tokens.ts, and a footer with the seller details from settings. The logo is
 * drawn with a table cell and text, or is the PNG rendition of the logo uploaded in Admin > Settings > Branding
 * (absolute APP_URL link; with a dark logo too, a <picture> source for prefers-color-scheme: dark, see logoHtml).
 * Every helper takes text that is ALREADY HTML-escaped, except where the parameter says "raw"; lib/email/render.ts does
 * the escaping. Pure module.
 */
import type { EmailLogo } from "@/lib/branding/model";
import { palette, tones } from "@/lib/design/tokens";

/** Seller details for the footer (SiteSetting "business"). */
export type EmailFooter = {
  legalName: string;
  address: string;
  city: string;
  state: string;
  pin: string;
  supportEmail: string;
};

export const EMAIL_COLORS = {
  page: palette.bg.portal,
  card: palette.surface,
  ink: palette.ink.DEFAULT,
  body: palette.ink.body,
  muted: palette.ink["2"],
  line: palette.line.DEFAULT,
  subtle: palette.line.subtle,
  primary: palette.primary.DEFAULT,
  onPrimary: palette.primary.foreground,
  link: palette.primary.link,
  codeBg: tones.lavender.soft,
  codeLine: tones.lavender.line,
  quoteBg: palette.bg.DEFAULT,
  /** Behind the dark-background logo when the reader's client is in dark mode. */
  logoDarkBg: palette.ink.DEFAULT,
} as const;

const C = EMAIL_COLORS;
const FONT = "Manrope,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace";
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

/** Escapes text for HTML element content and double- or single-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A body paragraph. */
export function paragraphHtml(html: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.body};">${html}</p>`;
}

/** Small print under a block. */
export function noteHtml(html: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:13px;line-height:1.55;color:${C.muted};">${html}</p>`;
}

/** An inline link (`rawUrl` is escaped here). */
export function linkHtml(rawUrl: string, labelHtml?: string): string {
  const href = escapeHtml(rawUrl);
  return `<a href="${href}" target="_blank" rel="noopener" style="color:${C.link};text-decoration:underline;word-break:break-all;">${labelHtml ?? href}</a>`;
}

/** Bulletproof button (a padded link inside a coloured cell), then the plain link as a fallback. */
export function buttonHtml(labelRaw: string, rawUrl: string): string {
  const href = escapeHtml(rawUrl);
  const label = escapeHtml(labelRaw);
  return (
    `<table ${TABLE} style="margin:8px 0 16px;border-collapse:separate;"><tr>` +
    `<td align="center" bgcolor="${C.primary}" style="border-radius:12px;background-color:${C.primary};">` +
    `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 22px;font-family:${FONT};` +
    `font-size:15px;font-weight:700;line-height:1.2;color:${C.onPrimary};text-decoration:none;border-radius:12px;">${label}</a>` +
    `</td></tr></table>` +
    noteHtml(`If the button doesn’t work, copy this link into your browser:<br>${linkHtml(rawUrl)}`)
  );
}

/** A one-time code in a large monospace box with a label above it. */
export function codeHtml(labelRaw: string, codeRaw: string): string {
  return (
    `<table ${TABLE} width="100%" style="margin:4px 0 16px;border-collapse:separate;"><tr>` +
    `<td align="center" bgcolor="${C.codeBg}" style="padding:16px 20px;border:1px solid ${C.codeLine};border-radius:12px;background-color:${C.codeBg};">` +
    `<div style="font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};">${escapeHtml(labelRaw)}</div>` +
    `<div style="margin-top:6px;font-family:${MONO};font-size:30px;font-weight:700;letter-spacing:0.2em;line-height:1.2;color:${C.ink};">${escapeHtml(codeRaw)}</div>` +
    `</td></tr></table>`
  );
}

/** Label/value rows. Values are HTML (already escaped). */
export function detailsHtml(rows: ReadonlyArray<{ label: string; valueHtml: string }>): string {
  const body = rows
    .map(
      (row, i) =>
        `<tr><td valign="top" style="padding:10px 14px;${i > 0 ? `border-top:1px solid ${C.subtle};` : ""}font-family:${FONT};font-size:13px;color:${C.muted};width:38%;">${escapeHtml(row.label)}</td>` +
        `<td valign="top" style="padding:10px 14px;${i > 0 ? `border-top:1px solid ${C.subtle};` : ""}font-family:${FONT};font-size:14px;font-weight:700;color:${C.ink};word-break:break-word;">${row.valueHtml}</td></tr>`,
    )
    .join("");
  return `<table ${TABLE} width="100%" style="margin:4px 0 16px;border:1px solid ${C.line};border-radius:12px;border-collapse:separate;">${body}</table>`;
}

/** A labelled box of multi-line text (already escaped, newlines as <br>). */
export function quoteHtml(labelRaw: string, valueHtml: string): string {
  return (
    `<p style="margin:0 0 6px;font-family:${FONT};font-size:13px;font-weight:700;color:${C.muted};">${escapeHtml(labelRaw)}</p>` +
    `<table ${TABLE} width="100%" style="margin:0 0 16px;border-collapse:separate;"><tr>` +
    `<td bgcolor="${C.quoteBg}" style="padding:12px 14px;border:1px solid ${C.line};border-radius:12px;background-color:${C.quoteBg};font-family:${FONT};font-size:14px;line-height:1.6;color:${C.ink};word-break:break-word;">${valueHtml}</td>` +
    `</tr></table>`
  );
}

function hostOf(appUrl: string): string {
  try {
    return new URL(appUrl).host;
  } catch {
    return appUrl;
  }
}

/** "Address, City, State PIN" without empty parts. */
export function footerAddress(footer: EmailFooter): string {
  const statePin = [footer.state, footer.pin].map((s) => s.trim()).filter(Boolean).join(" ");
  return [footer.address, footer.city, statePin].map((s) => s.trim()).filter(Boolean).join(", ");
}

/** Class of the logo cell: turned dark together with the dark logo (DARK_LOGO_STYLE). */
const LOGO_CELL_CLASS = "axs-logo";

/**
 * Only in emails with a dark logo: where the client applies prefers-color-scheme (Apple Mail, Outlook for Mac,
 * Thunderbird), the logo cell turns dark, so the dark logo that <picture> picks there sits on a dark backdrop even
 * though the rest of the email stays light. Clients without it ignore both and show the light logo.
 */
const DARK_LOGO_STYLE = `<style>@media (prefers-color-scheme: dark){.${LOGO_CELL_CLASS}{background-color:${C.logoDarkBg} !important;}}</style>`;

function imageHtml(image: EmailLogo["light"], alt: string): string {
  return (
    `<img src="${escapeHtml(image.src)}" width="${image.width}" height="${image.height}" alt="${escapeHtml(alt)}" ` +
    `style="display:block;height:auto;max-width:100%;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:800;color:${C.ink};">`
  );
}

/**
 * The uploaded logo (PNG rendition by absolute URL, alt = the brand name). With a dark logo: <picture> with a
 * prefers-color-scheme: dark source (width and height of its own); clients without <picture> keep the light <img>.
 */
function uploadedLogoHtml(appUrl: string, logo: EmailLogo): string {
  const light = imageHtml(logo.light, logo.alt);
  const image = logo.dark
    ? `<picture><source srcset="${escapeHtml(logo.dark.src)}" media="(prefers-color-scheme: dark)" width="${logo.dark.width}" height="${logo.dark.height}">${light}</picture>`
    : light;
  return (
    `<table ${TABLE}><tr><td class="${LOGO_CELL_CLASS}" style="padding:6px 8px;border-radius:12px;">` +
    `<a href="${escapeHtml(appUrl)}" target="_blank" rel="noopener" style="display:block;text-decoration:none;">${image}</a>` +
    `</td></tr></table>`
  );
}

function logoHtml(appUrl: string, logo?: EmailLogo | null): string {
  if (logo) return uploadedLogoHtml(appUrl, logo);
  const href = escapeHtml(appUrl);
  return (
    `<a href="${href}" target="_blank" rel="noopener" style="text-decoration:none;color:${C.ink};">` +
    `<table ${TABLE}><tr>` +
    `<td width="32" height="32" align="center" valign="middle" bgcolor="${C.primary}" style="width:32px;height:32px;border-radius:9px;background-color:${C.primary};font-family:${FONT};font-size:17px;font-weight:800;line-height:32px;color:${C.onPrimary};">A</td>` +
    `<td style="padding-left:10px;font-family:${FONT};line-height:1;">` +
    `<div style="font-size:18px;font-weight:800;letter-spacing:-0.025em;color:${C.ink};">Axiomatic</div>` +
    `<div style="margin-top:3px;font-size:9px;font-weight:700;letter-spacing:0.17em;text-transform:uppercase;color:${C.muted};">Software Solutions</div>` +
    `</td></tr></table></a>`
  );
}

function footerHtml(footer: EmailFooter, appUrl: string): string {
  const support = escapeHtml(footer.supportEmail);
  const lines = [
    `<strong style="color:${C.ink};">${escapeHtml(footer.legalName)}</strong>`,
    escapeHtml(footerAddress(footer)),
    `Questions? Email <a href="mailto:${support}" style="color:${C.link};text-decoration:underline;">${support}</a>`,
    `You received this email because of a request or purchase on ${escapeHtml(hostOf(appUrl))}.`,
  ].filter((line) => line !== "");
  return `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.7;color:${C.muted};">${lines.join("<br>")}</p>`;
}

export type EmailDocumentInput = {
  /** Raw subject (escaped here); also the document title. */
  subject: string;
  /** Raw preview text shown by inbox lists (escaped here). */
  preheader: string;
  /** The card content: paragraphs and blocks, already HTML. */
  contentHtml: string;
  footer: EmailFooter;
  appUrl: string;
  /** The logo uploaded in Admin > Settings > Branding; null or missing = the built-in table-and-text logo. */
  logo?: EmailLogo | null;
};

/** The full HTML document. */
export function emailDocumentHtml(input: EmailDocumentInput): string {
  return (
    `<!DOCTYPE html>\n<html lang="en"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light">` +
    `<meta name="supported-color-schemes" content="light">` +
    `<title>${escapeHtml(input.subject)}</title>${input.logo?.dark ? DARK_LOGO_STYLE : ""}</head>` +
    `<body style="margin:0;padding:0;background-color:${C.page};">` +
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preheader)}</div>` +
    `<table ${TABLE} width="100%" bgcolor="${C.page}" style="background-color:${C.page};"><tr>` +
    `<td align="center" style="padding:28px 12px;">` +
    `<!--[if mso]><table ${TABLE} width="600" align="center"><tr><td><![endif]-->` +
    `<table ${TABLE} width="100%" style="max-width:600px;">` +
    `<tr><td style="padding:0 4px 18px;">${logoHtml(input.appUrl, input.logo)}</td></tr>` +
    `<tr><td bgcolor="${C.card}" style="padding:30px 28px 14px;border:1px solid ${C.line};border-radius:16px;background-color:${C.card};">${input.contentHtml}</td></tr>` +
    `<tr><td style="padding:18px 4px 0;">${footerHtml(input.footer, input.appUrl)}</td></tr>` +
    `</table>` +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>`
  );
}

/** The plain-text alternative: content, a separator and the footer. */
export function emailDocumentText(input: { contentText: string; footer: EmailFooter; appUrl: string }): string {
  const footer = [
    input.footer.legalName.trim(),
    footerAddress(input.footer),
    `Questions? Email ${input.footer.supportEmail.trim()}`,
    `You received this email because of a request or purchase on ${hostOf(input.appUrl)}.`,
  ].filter((line) => line !== "");
  return `${input.contentText.trim()}\n\n--\n${footer.join("\n")}\n`;
}
