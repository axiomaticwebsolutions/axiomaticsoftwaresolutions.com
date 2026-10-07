import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { STORE_PATHS } from "@/components/store/active-nav";
import { Button } from "@/components/ui/button";
import { PRODUCT_COPY } from "./copy";

/** Prototype not-found state for /software/[slug] (unknown, DRAFT or HIDDEN products). Server-safe. */
export function ProductNotFound() {
  return (
    <div className="mx-auto box-content max-w-[672px] px-4 py-24 text-center leading-[normal] sm:px-6">
      <span aria-hidden="true" className="mx-auto grid size-16 place-items-center rounded-20 bg-peach-bg text-peach-fg">
        <Icon name="inventory_2" size={32} />
      </span>
      <h1 className="m-0 mt-[18px] text-[30px] font-extrabold">{PRODUCT_COPY.notFoundTitle}</h1>
      <p className="my-4 text-[16px] leading-[1.6] text-ink-2">{PRODUCT_COPY.notFoundBody}</p>
      <Button asChild className="mt-3 rounded-12 px-5 py-3 text-[16px] leading-[normal]">
        <Link href={STORE_PATHS.software}>{PRODUCT_COPY.notFoundCta}</Link>
      </Button>
    </div>
  );
}
