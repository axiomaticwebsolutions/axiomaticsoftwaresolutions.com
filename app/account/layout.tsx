import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import { PortalProvider } from "@/components/account/portal-context";
import { PORTAL_PATHS } from "@/components/account/portal-nav";
import { PortalSidebar, SignOutButton } from "@/components/account/portal-sidebar";
import { PortalToaster } from "@/components/account/portal-toaster";
import { PortalTopbar } from "@/components/account/portal-topbar";
import { SkipLink } from "@/components/store/skip-link";
import { NO_ACCOUNT_MESSAGE } from "@/lib/auth/guards";
import { log } from "@/lib/log";
import { getPortalState, toPortalContextData, type PortalState } from "@/lib/portal/context";
import { SITE_NAME } from "@/lib/seo/metadata";

export const metadata: Metadata = {
  // Prototype title "Account — Axiomatic Software Solutions"; pages name themselves ("Licenses — ...").
  title: { default: "Account", template: `%s \u2014 ${SITE_NAME}` },
  robots: { index: false, follow: false },
};

const NOTICE_BUTTON =
  "block w-full cursor-pointer rounded-12 border-0 p-[13px] text-center text-[15px] font-extrabold leading-[normal] no-underline transition-colors";

/** Full-page card in the style of the prototype's signed-out gate (440px, radius 20, lock tile). */
function PortalNotice({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-bg-portal p-6 leading-[normal]">
      <div className="w-[min(440px,100%)] rounded-20 border border-line-alt bg-surface p-8 text-center">
        <span aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-16 bg-lavender-bg text-lavender-fg">
          <Icon name={icon} size={28} />
        </span>
        <h1 className="mb-0 mt-4 text-[22px] font-extrabold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

async function loadState(): Promise<PortalState | null> {
  try {
    return await getPortalState();
  } catch (error) {
    // Redirects (sign-in, verify, admin) pass through; anything else (database down) gets the notice below.
    unstable_rethrow(error);
    log.warn("portal_layout_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Customer portal shell (decisions.md Phase 5): signed-in, verified customers only (lib/portal/context.ts redirects
 * everyone else). 256px sticky sidebar from 1000px (a drawer below), 58px top bar, <main> up to 1240px, toasts
 * bottom-right. Text uses `line-height: normal` like the prototype, which sets none.
 */
export default async function AccountLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const state = await loadState();
  if (!state) {
    return (
      <PortalNotice icon="error" title="We can’t load your account right now">
        <p className="mb-0 mt-2 text-[15px] leading-[1.6] text-ink-2">Please try again in a moment.</p>
        <a href={PORTAL_PATHS.overview} className={`${NOTICE_BUTTON} mt-5 bg-primary text-white hover:bg-primary-hover hover:text-white`}>
          Try again
        </a>
      </PortalNotice>
    );
  }
  if (state.kind === "no_account") {
    return (
      <PortalNotice icon="lock" title="No business account">
        <p className="mb-0 mt-2 text-[15px] leading-[1.6] text-ink-2">
          {NO_ACCOUNT_MESSAGE} Ask an account owner to invite {state.user.email}, or sign in with another email.
        </p>
        <SignOutButton className={`${NOTICE_BUTTON} mt-5 bg-primary text-white hover:bg-primary-hover`} />
        <Link href={PORTAL_PATHS.store} className="mt-3 inline-block rounded-6 text-[14px] font-bold text-primary-link hover:text-primary-link-hover">
          Back to store
        </Link>
      </PortalNotice>
    );
  }

  return (
    <PortalProvider value={toPortalContextData(state.context)}>
      <div className="min-h-dvh bg-bg-portal leading-[normal]">
        <SkipLink />
        <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] portal:grid-cols-[256px_minmax(0,1fr)]">
          <aside
            aria-label="Account navigation"
            className="sticky top-0 hidden h-dvh flex-col overflow-y-auto border-r border-line-alt bg-surface portal:flex"
          >
            <PortalSidebar />
          </aside>
          <div className="flex min-w-0 flex-col">
            <PortalTopbar />
            <main
              id="main"
              tabIndex={-1}
              className="mx-auto w-full max-w-portal flex-1 px-[clamp(14px,2.4vw,28px)] pb-20 pt-[clamp(18px,2.6vw,28px)] outline-none"
            >
              {children}
            </main>
          </div>
        </div>
        <PortalToaster />
      </div>
    </PortalProvider>
  );
}
