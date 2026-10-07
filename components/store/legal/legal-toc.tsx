import { LEGAL_COPY, type LegalSection } from "@/content/legal/documents";

export type LegalTocProps = {
  sections: readonly LegalSection[];
};

/**
 * "On this page": numbered fragment links to the sections, sticky beside the document from 900px (24px below the
 * header, the prototype's top:132px). Hidden on narrow screens (as prototyped) and when printing.
 */
export function LegalToc({ sections }: LegalTocProps) {
  return (
    <nav
      aria-labelledby="legal-toc-label"
      className="hidden gap-0.5 text-[14px] leading-[normal] print:hidden catalog:sticky catalog:top-[calc(var(--store-header-h)+24px)] catalog:grid"
    >
      <p
        id="legal-toc-label"
        className="px-2.5 pb-1.5 text-[12px] font-extrabold uppercase tracking-[.08em] text-ink-2"
      >
        {LEGAL_COPY.onThisPage}
      </p>
      <ol className="m-0 grid list-none gap-0.5 p-0">
        {sections.map((section, index) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="block rounded-9 px-2.5 py-[7px] font-semibold text-ink-soft no-underline transition-colors hover:bg-hover-lavender hover:text-ink"
            >
              {index + 1}. {section.heading}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
