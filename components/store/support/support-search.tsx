"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { RAISE_TICKET_HREF, SUPPORT_FAQ_COPY, SUPPORT_HERO, SUPPORT_LIVE_SEARCH_MIN } from "@/content/support";
import type { StoreFaq } from "@/lib/storefront/types";

type SupportSearchContextValue = {
  /** What is in the search box. */
  query: string;
  /** The query the FAQ list is filtered by ("" = no filter). */
  applied: string;
  /** Increments on every Search submit, so the results can take focus. */
  submits: number;
  setQuery: (value: string) => void;
  submit: () => void;
};

const SupportSearchContext = React.createContext<SupportSearchContextValue | null>(null);

function useSupportSearch(): SupportSearchContextValue {
  const value = React.useContext(SupportSearchContext);
  if (!value) throw new Error("useSupportSearch must be used inside <SupportSearchProvider>.");
  return value;
}

/**
 * Shares the hero search box with the FAQ list further down the page (the sections in between stay server-rendered).
 * Prototype rules: typing filters live from 3 characters (shorter clears the filter); Search applies any query.
 */
export function SupportSearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQueryState] = React.useState("");
  const [applied, setApplied] = React.useState("");
  const [submits, setSubmits] = React.useState(0);

  const value = React.useMemo<SupportSearchContextValue>(
    () => ({
      query,
      applied,
      submits,
      setQuery: (next) => {
        setQueryState(next);
        setApplied(next.length >= SUPPORT_LIVE_SEARCH_MIN ? next : "");
      },
      submit: () => {
        setApplied(query);
        setSubmits((n) => n + 1);
      },
    }),
    [query, applied, submits],
  );

  return <SupportSearchContext.Provider value={value}>{children}</SupportSearchContext.Provider>;
}

/** Hero search: 54px field with a search icon and a visually hidden label, plus the Search button. */
export function SupportSearchForm() {
  const { query, setQuery, submit } = useSupportSearch();
  return (
    <form
      role="search"
      className="mx-auto mt-5 flex max-w-[620px] gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="flex h-[54px] min-w-0 flex-1 cursor-text items-center gap-2 rounded-16 border border-sage-line bg-surface px-4 transition-[border-color,box-shadow] duration-150 focus-within:border-primary focus-within:shadow-focus">
        <Icon name="search" size={22} className="text-ink-3" />
        <span className="sr-only">{SUPPORT_HERO.searchLabel}</span>
        <input
          type="search"
          name="q"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={SUPPORT_HERO.searchPlaceholder}
          autoComplete="off"
          enterKeyHint="search"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[16px] font-semibold text-ink outline-none placeholder:text-ink-3 focus-visible:outline-hidden"
        />
      </label>
      <Button type="submit" className="h-[54px] rounded-16 px-5 py-0 text-[13.5px] font-extrabold leading-[normal]">
        {SUPPORT_HERO.searchButton}
      </Button>
    </form>
  );
}

function matches(faq: StoreFaq, needle: string): boolean {
  return `${faq.question} ${faq.answer}`.toLowerCase().includes(needle);
}

/**
 * "Common questions" (Faq page "support"): single-open accordion, first item open. While a search is applied the
 * heading becomes "{n} answers for “{q}”", every match starts expanded and each one can still be collapsed (the
 * prototype ignored the toggles while filtering). The count is announced politely; a Search submit moves focus here.
 */
export function SupportFaqs({ faqs }: { faqs: readonly StoreFaq[] }) {
  const { applied, submits } = useSupportSearch();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [singleOpen, setSingleOpen] = React.useState<string | null>(faqs[0]?.id ?? null);
  const [filteredOpen, setFilteredOpen] = React.useState<{ query: string; ids: string[] }>({ query: "", ids: [] });

  const needle = applied.trim().toLowerCase();
  const list = needle ? faqs.filter((f) => matches(f, needle)) : faqs;
  const title = needle ? SUPPORT_FAQ_COPY.resultsTitle(list.length, applied.trim()) : SUPPORT_FAQ_COPY.title;
  const openIds = needle
    ? filteredOpen.query === needle
      ? filteredOpen.ids
      : list.map((f) => f.id)
    : singleOpen
      ? [singleOpen]
      : [];

  React.useEffect(() => {
    if (submits === 0) return;
    const heading = headingRef.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    heading.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [submits]);

  function onValueChange(next: string[]) {
    if (needle) {
      setFilteredOpen({ query: needle, ids: next });
      return;
    }
    setSingleOpen(next.find((id) => id !== singleOpen) ?? null);
  }

  return (
    <>
      <h2
        id="support-faq-title"
        ref={headingRef}
        tabIndex={-1}
        className="m-0 scroll-mt-1 text-[clamp(24px,2.6vw,30px)] font-extrabold leading-[normal] tracking-[-0.03em]"
      >
        {title}
      </h2>
      <p role="status" className="sr-only">
        {needle ? title : ""}
      </p>
      <div className="mt-[18px] border-t border-line">
        {list.length > 0 ? (
          <Accordion type="multiple" value={openIds} onValueChange={onValueChange}>
            {list.map((faq) => (
              <AccordionItem key={faq.id} value={faq.id} className="last:border-b">
                <AccordionTrigger className="rounded-none py-[18px] leading-[normal] [&>span]:h-[26px] [&>span]:w-[22px] [&>span]:rounded-none [&>span]:bg-transparent [&_svg]:size-[22px]">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="pb-[18px] pr-10 leading-[1.65]">
                  {faq.answer}
                  {faq.href ? (
                    <>
                      {" "}
                      <Link href={faq.href} className="font-bold text-primary-link underline hover:text-primary-link-hover">
                        {SUPPORT_FAQ_COPY.readGuide}
                      </Link>
                    </>
                  ) : null}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        ) : (
          <p className="my-4 py-6 text-ink-2">
            {SUPPORT_FAQ_COPY.emptyBefore}
            <Link href={RAISE_TICKET_HREF} className="font-bold text-primary-link underline hover:text-primary-link-hover">
              {SUPPORT_FAQ_COPY.emptyLink}
            </Link>
            {SUPPORT_FAQ_COPY.emptyAfter}
          </p>
        )}
      </div>
    </>
  );
}
