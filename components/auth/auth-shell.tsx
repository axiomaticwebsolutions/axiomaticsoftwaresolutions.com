import Link from "next/link";
import type * as React from "react";
import { LogoMark } from "@/components/brand/logo";
import { Icon, type IconName } from "@/components/icons/icon";
import { AUTH_ASIDE, AUTH_BRAND } from "./copy";

/** Brand panel copy: a headline and short icon bullets. */
export type AuthAside = {
  headline: string;
  bullets: ReadonlyArray<{ icon: IconName; text: string }>;
};

const HOME_LABEL = "Axiomatic Software Solutions — home";

/**
 * Split layout of the auth pages (Account.dc.html): a lavender brand panel with decorative circles on the left from
 * 900px (`catalog:`; the prototype measured the window in JS), and the 420px form column centred on the right. Below
 * 900px only the column shows, with a compact logo above the form. The panel's headline is a <p> so the page keeps a
 * single <h1>; the prototype's "Prototype · accounts are stored in this browser only" note is gone (its slot is kept
 * empty so the headline stays where the design puts it). `aside` replaces the customer copy of the brand panel (the
 * staff invitation page). Server component.
 */
export function AuthShell({ children, aside = AUTH_ASIDE }: { children: React.ReactNode; aside?: AuthAside }) {
  return (
    <div className="grid min-h-dvh leading-[normal] catalog:grid-cols-2">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-lavender-bg p-12 catalog:flex">
        <div aria-hidden="true" className="absolute -bottom-[120px] -right-[120px] size-[420px] rounded-pill bg-pink-bg" />
        <div aria-hidden="true" className="absolute -left-20 bottom-[120px] size-60 rounded-pill bg-blue-bg" />
        <Link
          href="/"
          aria-label={HOME_LABEL}
          className="relative flex items-center gap-[11px] self-start rounded-10 text-ink no-underline"
        >
          <LogoMark size={36} />
          <span aria-hidden="true" className="flex flex-col leading-none">
            <span className="text-[19px] font-extrabold tracking-[-0.025em]">{AUTH_BRAND}</span>
            <span className="mt-1 text-[9px] font-bold uppercase tracking-[0.17em] text-ink-2">Software Solutions</span>
          </span>
        </Link>
        <div className="relative max-w-[440px]">
          <p className="m-0 text-[34px] font-extrabold leading-[1.1] tracking-[-0.035em] text-ink">{aside.headline}</p>
          <ul className="m-0 mt-6 grid list-none gap-3 p-0 text-[15.5px] font-bold text-ink">
            {aside.bullets.map((item) => (
              <li key={item.icon} className="flex min-h-[25px] items-center gap-2.5">
                <Icon name={item.icon} size={21} className="text-lavender-fg" />
                {item.text}
              </li>
            ))}
          </ul>
        </div>
        <span aria-hidden="true" className="relative h-[18px]" />
      </aside>
      <main id="main" className="grid min-w-0 place-items-center px-5 py-10">
        <div className="w-full max-w-[420px]">
          <Link
            href="/"
            aria-label={HOME_LABEL}
            className="mb-7 inline-flex items-center gap-2.5 rounded-10 text-[18px] font-extrabold text-ink no-underline catalog:hidden"
          >
            <LogoMark size={32} />
            <span aria-hidden="true">{AUTH_BRAND}</span>
          </Link>
          {children}
        </div>
      </main>
    </div>
  );
}
