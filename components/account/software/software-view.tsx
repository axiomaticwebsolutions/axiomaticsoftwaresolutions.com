import Link from "next/link";
import type { SoftwareView as SoftwareViewModel } from "@/lib/software/view";
import { CATALOG_PATH, SOFTWARE_COPY } from "./model";
import { SoftwareProductCard } from "./product-card";

/**
 * Product cards of "Software & downloads" (one per product the account holds a license for, ordered by catalog rank),
 * or the prototype's dashed empty state.
 */
export function SoftwareView({ view, linkMinutes }: { view: SoftwareViewModel; linkMinutes: number }) {
  if (view.products.length === 0) {
    return (
      <div className="rounded-16 border border-dashed border-line-input bg-surface p-12 text-center max-[29.99rem]:px-6">
        <h2 className="m-0 text-[18px] font-extrabold">{SOFTWARE_COPY.emptyTitle}</h2>
        <p className="my-4 text-ink-2">{SOFTWARE_COPY.emptyBody}</p>
        <Link href={CATALOG_PATH} className="rounded-6 font-bold text-primary-link underline hover:text-primary-link-hover">
          {SOFTWARE_COPY.emptyCta}
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-3.5">
      {view.products.map((product) => (
        <SoftwareProductCard key={product.productId} product={product} linkMinutes={linkMinutes} />
      ))}
    </div>
  );
}
