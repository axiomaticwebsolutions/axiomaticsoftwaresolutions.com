import Link from "next/link";
import { legalDocHref, legalDocuments, type LegalDocSlug } from "@/content/legal/documents";
import { cn } from "@/lib/utils";

export type LegalDocNavProps = {
  current: LegalDocSlug;
  className?: string;
};

/**
 * Document switcher: Terms · Privacy · Refunds · License agreement. Links (each document is its own page), not the
 * prototype's ARIA tabs; the current one has aria-current="page" and the lavender look. Hidden when printing.
 */
export function LegalDocNav({ current, className }: LegalDocNavProps) {
  return (
    <nav aria-label="Legal documents" className={cn("print:hidden", className)}>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {legalDocuments().map((doc) => {
          const active = doc.slug === current;
          return (
            <li key={doc.slug}>
              <Link
                href={legalDocHref(doc.slug)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block rounded-12 border px-4 py-2.5 text-[14.5px] font-bold leading-[normal] no-underline transition-colors",
                  active
                    ? "border-primary-accent bg-lavender-bg text-lavender-fg"
                    : "border-line bg-surface text-ink hover:border-primary-accent hover:text-ink",
                )}
              >
                {doc.tabLabel}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
