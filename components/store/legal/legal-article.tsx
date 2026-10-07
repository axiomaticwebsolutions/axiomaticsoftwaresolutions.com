import { LegalText } from "@/components/store/legal/legal-text";
import { PrintButton } from "@/components/store/legal/print-button";
import { LEGAL_COPY, type LegalDocument, type LegalValues } from "@/content/legal/documents";
import type { BusinessSettings } from "@/lib/config";
import { formatDateIST, startOfDayIST } from "@/lib/dates";

export type LegalArticleProps = {
  doc: LegalDocument;
  values: LegalValues;
  /** Seller identity printed under the document (legal name comes through `values.sellerName`). */
  business: Pick<BusinessSettings, "address" | "city" | "pin" | "state">;
};

/**
 * The document card: h1 title, "Last updated {date} · Version {n} (draft)", Print, the intro, numbered sections
 * (fragment ids from the content) and the questions footer with the seller's postal address. Server component.
 */
export function LegalArticle({ doc, values, business }: LegalArticleProps) {
  const updated = formatDateIST(startOfDayIST(doc.lastUpdated));
  const address = [business.address, `${business.city} ${business.pin}`.trim(), business.state]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
  return (
    <article
      aria-labelledby="legal-title"
      className="min-w-0 rounded-24 border border-line bg-surface p-[clamp(22px,4vw,44px)] print:rounded-none print:border-0 print:p-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            id="legal-title"
            className="text-[clamp(26px,3vw,36px)] font-extrabold leading-[normal] tracking-[-0.03em]"
          >
            {doc.title}
          </h1>
          <p className="mt-1.5 text-[14px] font-semibold text-ink-2">
            Last updated <time dateTime={doc.lastUpdated}>{updated}</time> · Version {doc.version}
            {doc.status === "sample" ? " (draft)" : ""}
          </p>
        </div>
        <PrintButton label={LEGAL_COPY.print} />
      </div>

      <p className="mt-[18px] text-[16px] leading-[1.7] text-ink-soft">
        <LegalText text={doc.intro} values={values} />
      </p>

      {doc.sections.map((section, index) => (
        <section
          key={section.id}
          id={section.id}
          className="mt-7 scroll-mt-2.5 print:break-inside-avoid-page"
        >
          <h2 className="text-[19px] font-extrabold leading-[normal]">
            {index + 1}. {section.heading}
          </h2>
          {section.paragraphs.map((paragraph, p) => (
            <p key={p} className="mt-2.5 text-[15.5px] leading-[1.75] text-ink-soft [text-wrap:pretty]">
              <LegalText text={paragraph} values={values} />
            </p>
          ))}
        </section>
      ))}

      <footer className="mt-8 border-t border-line-subtle pt-[18px] text-[14.5px] leading-[1.6] text-ink-2">
        <p>
          <LegalText text={LEGAL_COPY.footer} values={values} />
        </p>
        {address ? (
          <address className="mt-1 not-italic">
            {values.sellerName}, {address}
          </address>
        ) : null}
      </footer>
    </article>
  );
}
