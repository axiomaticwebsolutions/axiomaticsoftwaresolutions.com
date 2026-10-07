/**
 * Placeholder templates for code content (docs guides, legal documents). Copy may contain `{token}` placeholders that
 * are filled at render time from settings and env (e.g. "Links expire after {downloadLinkTime}"). Pure and
 * client-safe. Unknown tokens are left as written; tests/unit/docs-legal-content.test.ts checks that every token used
 * in the content is known.
 */

export type TemplatePart = { kind: "text"; text: string } | { kind: "token"; name: string };

/** Splits copy into text runs and tokens, in order ("a {x} b" -> text "a ", token x, text " b"). */
export function splitTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  // `{name}`: a letter followed by letters or digits. Braces around anything else are plain text.
  const re = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
  let last = 0;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    parts.push({ kind: "token", name: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** Token names used in a piece of copy, in order of appearance (duplicates kept). */
export function templateTokens(text: string): string[] {
  return splitTemplate(text).flatMap((part) => (part.kind === "token" ? [part.name] : []));
}

/** The value of a token, or undefined when `values` has no own property of that name. */
export function tokenValue(values: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

/** Fills every known token; unknown tokens stay as `{name}`. */
export function fillTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return splitTemplate(text)
    .map((part) => (part.kind === "text" ? part.text : (tokenValue(values, part.name) ?? `{${part.name}}`)))
    .join("");
}

/** "1 minute", "10 minutes" (English plural with an optional irregular form). */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
