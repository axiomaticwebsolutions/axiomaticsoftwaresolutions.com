import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { adminActionClassName } from "@/components/admin/action-styles";
import { ADMIN_HOME, adminTitle } from "@/components/admin/admin-nav";
import { AdminPageHeader } from "@/components/admin/admin-page-header";

// Same segment as app/admin/layout.tsx, so its title template does not apply: absolute title.
export const metadata: Metadata = { title: adminTitle("Page not found"), robots: { index: false, follow: false } };

/**
 * Not found inside the admin shell: unknown /admin/* URLs (app/admin/[...slug]) and notFound() from module pages
 * that have no not-found state of their own (the prototype fell back to the overview).
 */
export default function AdminNotFound() {
  return (
    <>
      <AdminPageHeader title="Page not found" description="This page isn’t part of the admin console." />
      <div className="rounded-16 border border-dashed border-line-input bg-surface px-6 py-12 text-center">
        <span aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-16 bg-lavender-bg text-lavender-fg">
          <Icon name="search_off" size={28} />
        </span>
        <h2 className="mb-0 mt-3.5 text-[19px] font-extrabold leading-[1.3]">We couldn’t find that page</h2>
        <p className="mx-auto mb-0 mt-1.5 max-w-[440px] text-[14px] leading-[1.6] text-ink-2">
          The link may be out of date, or the page may have moved. Pick a module from the menu or start again from the
          overview.
        </p>
        <Link href={ADMIN_HOME} className={`${adminActionClassName("primary")} mt-4`}>
          <Icon name="space_dashboard" size={18} />
          Back to overview
        </Link>
      </div>
    </>
  );
}
