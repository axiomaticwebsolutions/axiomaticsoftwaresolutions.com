"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import {
  docsResultsLabel,
  normalizeDocsQuery,
  searchDocs,
  type DocsSearchEntry,
} from "@/content/docs/search";

type DocsSearchState = {
  query: string;
  setQuery: (query: string) => void;
  results: DocsSearchEntry[];
  searching: boolean;
};

const DocsSearchContext = React.createContext<DocsSearchState | null>(null);

function useDocsSearch(): DocsSearchState {
  const state = React.useContext(DocsSearchContext);
  if (!state) throw new Error("DocsSearchField and DocsSearchResults must be inside <DocsSearchProvider>.");
  return state;
}

export type DocsSearchProviderProps = {
  /** Every guide, resolved on the server (content/docs/search.ts). */
  index: readonly DocsSearchEntry[];
  children: React.ReactNode;
};

/**
 * Live docs search shared by the hero field and the reading area. The query belongs to the page it was typed on, so
 * following any guide link clears it (as the prototype does on navigation).
 */
export function DocsSearchProvider({ index, children }: DocsSearchProviderProps) {
  const pathname = usePathname();
  const [state, setState] = React.useState({ query: "", path: pathname });
  const query = state.path === pathname ? state.query : "";
  const value = React.useMemo<DocsSearchState>(() => {
    const results = searchDocs(index, query);
    return {
      query,
      setQuery: (next: string) => setState({ query: next, path: pathname }),
      results,
      searching: normalizeDocsQuery(query) !== "",
    };
  }, [index, query, pathname]);
  return <DocsSearchContext.Provider value={value}>{children}</DocsSearchContext.Provider>;
}

/**
 * Search field in the docs hero (50px, radius 14, blue line border, search icon). The visible focus ring sits on the
 * wrapper. Escape clears the query. A polite status announces the result count while typing.
 */
export function DocsSearchField() {
  const { query, setQuery, results, searching } = useDocsSearch();
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      setQuery("");
    }
  };
  return (
    <div role="search" className="mt-4 max-w-[560px]">
      <label className="flex h-[50px] items-center gap-2 rounded-14 border border-blue-line bg-surface px-3.5 transition-[border-color,box-shadow] duration-150 focus-within:border-primary focus-within:shadow-focus">
        <Icon name="search" size={22} className="text-ink-3" />
        <VisuallyHidden>Search documentation</VisuallyHidden>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search guides, e.g. activate, backup, printer"
          autoComplete="off"
          enterKeyHint="search"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[15.5px] font-semibold text-ink outline-none placeholder:text-ink-3 focus-visible:outline-hidden"
        />
      </label>
      <VisuallyHidden role="status">{searching ? docsResultsLabel(results.length, query) : ""}</VisuallyHidden>
    </div>
  );
}

/** While a query is typed: the matching guides (or the empty state). Otherwise: the guide itself (children). */
export function DocsSearchResults({ children }: { children: React.ReactNode }) {
  const { query, setQuery, results, searching } = useDocsSearch();
  const headingId = React.useId();
  if (!searching) return <>{children}</>;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-[20px] font-extrabold leading-[normal]">
        {docsResultsLabel(results.length, query)}
      </h2>
      {results.length > 0 ? (
        <ul className="mt-3.5 grid list-none gap-2.5 p-0">
          {results.map((entry) => (
            <li key={entry.slug}>
              <Link
                href={entry.href}
                onClick={() => setQuery("")}
                className="block rounded-16 border border-line bg-surface px-[18px] py-4 text-ink no-underline transition-colors hover:border-primary-accent"
              >
                <span className="block text-[12.5px] font-extrabold text-ink-2">{entry.group}</span>
                <span className="mt-0.5 block font-extrabold">{entry.title}</span>
                <span className="mt-1 block text-[14px] text-ink-2">{entry.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-7 rounded-18 border border-dashed border-line-input bg-surface p-7 text-center text-ink-2">
          Nothing found. Try another word, or{" "}
          <Link href="/support" className="text-primary-link underline hover:text-primary-link-hover">
            ask support
          </Link>
          .
        </p>
      )}
    </section>
  );
}
