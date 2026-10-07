import Link from "next/link";
import { PriceToggle } from "@/components/store/price";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export const CATALOG_TITLE = "Software";
export const CATALOG_INTRO =
  "Licensed software for billing, invoicing and payments. Compare up to three products side by side.";

/** Breadcrumb, H1, intro and the price display toggle (shared by the page and its loading state). Server-safe. */
export function CatalogIntro({ ratePct }: { ratePct?: number }) {
  return (
    <>
      <Breadcrumb>
        <BreadcrumbList className="gap-x-2">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{CATALOG_TITLE}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="mt-[18px] flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="m-0 text-[clamp(32px,4vw,46px)] font-extrabold leading-[1.05] tracking-[-0.035em]">
            {CATALOG_TITLE}
          </h1>
          <p className="mt-3 max-w-[620px] text-[17px] leading-[1.6] text-ink-2">{CATALOG_INTRO}</p>
        </div>
        <PriceToggle ratePct={ratePct} />
      </div>
    </>
  );
}
