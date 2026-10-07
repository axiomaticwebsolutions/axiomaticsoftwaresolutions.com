import type { Metadata } from "next";
import Link from "next/link";
import StoreLayout from "@/app/(store)/layout";
import { Icon } from "@/components/icons/icon";
import { STORE_PATHS } from "@/components/store/active-nav";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

/**
 * Global 404 (unknown URLs, and notFound() from any route without a closer not-found boundary). Rendered inside the
 * storefront shell, in the style of the product page's not-found state.
 */
export default function NotFound() {
  return (
    <StoreLayout>
      <div className="mx-auto max-w-[720px] px-4 py-24 text-center sm:px-6">
        <span
          aria-hidden="true"
          className="mx-auto grid size-16 place-items-center rounded-20 bg-lavender-bg text-lavender-fg"
        >
          <Icon name="search_off" size={32} />
        </span>
        <h1 className="mb-0 mt-[18px] text-[30px] font-extrabold leading-[1.2] tracking-[-0.02em]">
          We couldn’t find that page
        </h1>
        <p className="mx-auto mb-0 mt-3 max-w-[480px] text-[16px] leading-[1.6] text-ink-2">
          The link may be out of date, or the page may have moved. Try our software catalog or start from the home page.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link href={STORE_PATHS.software}>Browse all software</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href={STORE_PATHS.home}>Go to the home page</Link>
          </Button>
        </div>
      </div>
    </StoreLayout>
  );
}
