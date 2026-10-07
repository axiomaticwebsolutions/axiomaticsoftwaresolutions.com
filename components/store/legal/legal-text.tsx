import Link from "next/link";
import { Fragment } from "react";
import { splitTemplate, tokenValue } from "@/content/docs/template";
import { CONTACT_LINK_TOKEN, LEGAL_COPY, LEGAL_EMAIL_TOKENS, type LegalValues } from "@/content/legal/documents";

const LINK_CLASS = "rounded-6 text-primary-link underline hover:text-primary-link-hover";

export type LegalTextProps = {
  /** Copy with `{token}` placeholders (content/legal/documents.ts). */
  text: string;
  values: LegalValues;
};

/**
 * Renders legal copy with its tokens filled: email tokens become mailto: links, `{contactUs}` links to /contact, the
 * rest are plain text. Unknown tokens stay visible as `{name}` (tests keep the content free of them). Server-safe.
 */
export function LegalText({ text, values }: LegalTextProps) {
  return splitTemplate(text).map((part, index) => {
    const key = `${index}-${part.kind}`;
    if (part.kind === "text") return <Fragment key={key}>{part.text}</Fragment>;
    if (part.name === CONTACT_LINK_TOKEN) {
      return (
        <Link key={key} href="/contact" className={LINK_CLASS}>
          {LEGAL_COPY.contactUs}
        </Link>
      );
    }
    const value = tokenValue(values, part.name);
    if (value === undefined) return <Fragment key={key}>{`{${part.name}}`}</Fragment>;
    if (LEGAL_EMAIL_TOKENS.has(part.name)) {
      return (
        <a key={key} href={`mailto:${value}`} className={LINK_CLASS}>
          {value}
        </a>
      );
    }
    return <Fragment key={key}>{value}</Fragment>;
  });
}
