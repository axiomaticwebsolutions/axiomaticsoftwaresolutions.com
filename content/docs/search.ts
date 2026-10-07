/**
 * Docs search (Docs.dc.html): case-insensitive substring match over each guide's title, summary and step text
 * (every OS variant). Pure and client-safe; the page builds the index from the resolved guides on the server.
 */
import type { DocGroup } from "./guides";
import type { ResolvedGuide, ResolvedStep } from "./values";

export type DocsSearchEntry = {
  slug: string;
  href: string;
  group: DocGroup;
  title: string;
  summary: string;
  /** Lower-case text the query is matched against. */
  text: string;
};

function stepText(steps: readonly ResolvedStep[] | null | undefined): string[] {
  return (steps ?? []).flatMap((step) => [step.title, step.body, step.code ?? ""]);
}

export function docsSearchIndex(guides: readonly ResolvedGuide[]): DocsSearchEntry[] {
  return guides.map((guide) => ({
    slug: guide.slug,
    href: guide.href,
    group: guide.group,
    title: guide.title,
    summary: guide.summary,
    text: [
      guide.title,
      guide.summary,
      ...stepText(guide.steps),
      ...Object.values(guide.platformSteps ?? {}).flatMap(stepText),
    ]
      .join(" ")
      .toLowerCase(),
  }));
}

/** The query as matched: trimmed and lower-cased ("" means not searching). */
export function normalizeDocsQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Guides matching the query, in reading order; [] for a blank query. */
export function searchDocs(index: readonly DocsSearchEntry[], query: string): DocsSearchEntry[] {
  const q = normalizeDocsQuery(query);
  return q ? index.filter((entry) => entry.text.includes(q)) : [];
}

/** "1 result for “backup”", "3 results for “key”" (the query as typed, trimmed). */
export function docsResultsLabel(count: number, query: string): string {
  return `${count} result${count === 1 ? "" : "s"} for “${query.trim()}”`;
}
