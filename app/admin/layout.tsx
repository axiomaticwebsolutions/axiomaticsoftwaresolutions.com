import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import type * as React from "react";
import { AdminProvider } from "@/components/admin/admin-context";
import { ADMIN_HOME, ADMIN_TITLE_SUFFIX } from "@/components/admin/admin-nav";
import { AdminNotice, NOTICE_BUTTON } from "@/components/admin/admin-notice";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AdminToaster } from "@/components/admin/admin-toaster";
import { AdminTopbar } from "@/components/admin/admin-topbar";
import { StaffSignOutButton } from "@/components/admin/sign-out";
import { SkipLink } from "@/components/store/skip-link";
import { getAdminState, toAdminContextData, type AdminState } from "@/lib/admin/context";
import { log } from "@/lib/log";

export const metadata: Metadata = {
  // Prototype title "Admin — Axiomatic Software Solutions"; modules: "Orders, payments & refunds · Admin — ...".
  title: { default: "Admin", template: `%s \u00b7 ${ADMIN_TITLE_SUFFIX}` },
  robots: { index: false, follow: false },
};

async function loadState(): Promise<AdminState | null> {
  try {
    return await getAdminState();
  } catch (error) {
    // Redirects (sign-in, customers to /account) pass through; anything else (database down) gets the notice below.
    unstable_rethrow(error);
    log.warn("admin_layout_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Admin console shell (decisions.md Phase 6): active staff only (lib/admin/context.ts redirects everyone else).
 * 232px dark sticky sidebar from 1040px (a drawer below), 56px top bar, <main> up to 1360px, toasts bottom-right.
 * Text uses `line-height: normal` like the prototype, which sets none.
 */
export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const state = await loadState();
  if (!state) {
    return (
      <AdminNotice icon="error" title="We can’t load the admin console right now">
        <p className="mb-0 mt-2 text-[15px] leading-[1.6] text-ink-2">Please try again in a moment.</p>
        <a href={ADMIN_HOME} className={NOTICE_BUTTON}>
          Try again
        </a>
      </AdminNotice>
    );
  }
  if (state.kind === "inactive") {
    return (
      <AdminNotice icon="lock" title="Your staff access isn’t active">
        <p className="mb-0 mt-2 text-[15px] leading-[1.6] text-ink-2">
          {state.user.email} can’t use the admin console right now. Ask the account owner to restore your access.
        </p>
        <StaffSignOutButton className={NOTICE_BUTTON} />
        <AdminToaster />
      </AdminNotice>
    );
  }

  return (
    <AdminProvider value={toAdminContextData(state.context)}>
      <div className="min-h-dvh bg-bg-admin leading-[normal]">
        <SkipLink />
        <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] admin:grid-cols-[232px_minmax(0,1fr)]">
          {/* The column carries the sidebar surface for the full page height; the menu itself stays in view (sticky). */}
          <div className="hidden border-r border-line bg-surface admin:block">
            <aside aria-label="Admin navigation" className="sticky top-0 flex h-dvh flex-col">
              <AdminSidebar />
            </aside>
          </div>
          <div className="flex min-w-0 flex-col">
            <AdminTopbar />
            <main
              id="main"
              tabIndex={-1}
              className="mx-auto w-full max-w-admin flex-1 px-[clamp(12px,2vw,32px)] pb-20 pt-[clamp(16px,2.2vw,24px)] outline-none"
            >
              {children}
            </main>
          </div>
        </div>
        <AdminToaster />
      </div>
    </AdminProvider>
  );
}
