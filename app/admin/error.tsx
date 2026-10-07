"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { adminActionClassName } from "@/components/admin/action-styles";
import { ADMIN_HOME, moduleKeyForPath } from "@/components/admin/admin-nav";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { adminGroupTitle, adminModule } from "@/lib/rbac";

/**
 * Error boundary for admin pages (inside the shell, so navigation keeps working). "Try again" re-renders the
 * segment and refreshes server data. The message never shows error details (production errors only carry a digest).
 */
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const key = moduleKeyForPath(pathname);
  const mod = key ? adminModule(key) : null;
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  React.useEffect(() => {
    console.error(error);
    headingRef.current?.focus();
  }, [error]);

  return (
    <>
      <AdminPageHeader group={mod ? adminGroupTitle(mod.group) : undefined} title={mod?.title ?? "Admin"} />
      <div role="alert" className="rounded-16 border border-line-alt bg-surface px-6 py-12 text-center">
        <span aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-16 bg-pink-bg text-pink-fg">
          <Icon name="error" size={28} />
        </span>
        <h2 ref={headingRef} tabIndex={-1} className="mb-0 mt-3.5 text-[19px] font-extrabold leading-[1.3] outline-none">
          We couldn’t load this page
        </h2>
        <p className="mx-auto mb-0 mt-1.5 max-w-[440px] text-[14px] leading-[1.6] text-ink-2">
          Something went wrong on our side. Please try again.
          {error.digest ? <span className="block text-[12.5px]">Reference: {error.digest}</span> : null}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => {
              router.refresh();
              reset();
            }}
            className={adminActionClassName("primary")}
          >
            <Icon name="restart_alt" size={18} />
            Try again
          </button>
          <Link href={ADMIN_HOME} className={adminActionClassName("default")}>
            Back to overview
          </Link>
        </div>
      </div>
    </>
  );
}
