import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { PageHeader } from "@/components/account/page-header";
import { PORTAL_PATHS } from "@/components/account/portal-nav";

export const metadata: Metadata = { title: "Page not found" };

/**
 * Not found inside the portal shell: unknown /account/* URLs (app/account/[...slug]) and notFound() from portal pages
 * that have no not-found state of their own.
 */
export default function AccountNotFound() {
  return (
    <>
      <PageHeader title="Page not found" description="This page isn’t part of your account." />
      <div className="rounded-16 border border-dashed border-line-input bg-surface px-6 py-12 text-center">
        <span aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-16 bg-lavender-bg text-lavender-fg">
          <Icon name="search_off" size={28} />
        </span>
        <h2 className="mb-0 mt-3.5 text-[19px] font-extrabold leading-[1.3]">We couldn’t find that page</h2>
        <p className="mx-auto mb-0 mt-1.5 max-w-[440px] text-[14px] leading-[1.6] text-ink-2">
          The link may be out of date, or the page may have moved. Start again from the overview.
        </p>
        <Link
          href={PORTAL_PATHS.overview}
          className="mt-4 inline-flex items-center gap-1.5 rounded-10 border border-primary bg-primary px-3.5 py-[9px] text-[14px] font-bold text-white no-underline transition-colors hover:bg-primary-hover hover:text-white"
        >
          <Icon name="space_dashboard" size={18} />
          Back to overview
        </Link>
      </div>
    </>
  );
}
