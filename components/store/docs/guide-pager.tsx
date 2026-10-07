import Link from "next/link";
import { cn } from "@/lib/utils";

export type GuidePagerLink = { title: string; href: string };

export type GuidePagerProps = {
  prev: GuidePagerLink | null;
  next: GuidePagerLink | null;
};

const CARD_CLASS =
  "block rounded-16 border border-line bg-surface px-4 py-3.5 leading-[normal] text-ink no-underline transition-colors hover:border-primary-accent";

/** "← Previous" / "Next →" cards under the guide (two columns at every width; Next always in the right column). */
export function GuidePager({ prev, next }: GuidePagerProps) {
  if (!prev && !next) return null;
  return (
    <nav aria-label="Previous and next guides" className="mt-4 grid grid-cols-2 gap-3">
      {prev ? (
        <Link href={prev.href} rel="prev" className={CARD_CLASS}>
          <span className="block text-[12.5px] font-bold text-ink-2">
            <span aria-hidden="true">← </span>Previous
          </span>
          <span className="block font-extrabold">{prev.title}</span>
        </Link>
      ) : null}
      {next ? (
        <Link href={next.href} rel="next" className={cn(CARD_CLASS, "col-start-2 text-right")}>
          <span className="block text-[12.5px] font-bold text-ink-2">
            Next<span aria-hidden="true"> →</span>
          </span>
          <span className="block font-extrabold">{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}
