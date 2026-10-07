"use client";

import Link from "next/link";
import { CUSTOMER_HOME, signInPath } from "@/lib/auth/redirect";
import type { OrderViewer } from "./order-model";
import { saveRegisterPrefill } from "./session-keys";

export type OrderNextStepsProps = {
  orderId: string;
  email: string;
  viewer: OrderViewer;
  canClaim: boolean;
};

const CTA =
  "mt-4 inline-block rounded-12 bg-primary px-[18px] py-3 font-bold text-primary-foreground no-underline transition-colors hover:bg-primary-hover hover:text-primary-foreground";

/** "Next steps" and the account prompt (Order.dc.html, paid orders). Hidden in print. */
export function OrderNextSteps({ orderId, email, viewer, canClaim }: OrderNextStepsProps) {
  const orderPath = `/orders/${encodeURIComponent(orderId)}`;
  return (
    <section
      aria-labelledby="next-h"
      className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4 print:hidden"
    >
      <div className="rounded-22 border border-line bg-surface p-6">
        <h2 id="next-h" className="text-lg font-extrabold">
          Next steps
        </h2>
        <ol className="mt-3.5 grid list-decimal gap-2.5 pl-5 text-[15px] leading-[1.55]">
          <li>Download and run the installer on the computer you bill from.</li>
          <li>
            Open the software and choose <strong>Activate license</strong>.
          </li>
          <li>Paste your key. The computer appears under Licenses in your account.</li>
        </ol>
        <Link
          href="/docs/install"
          className="mt-3.5 inline-block rounded-6 font-bold text-primary-link underline underline-offset-2 hover:text-primary-link-hover"
        >
          Installation guide →
        </Link>
      </div>
      <div className="rounded-22 bg-lavender-bg p-6">
        {viewer.member ? (
          <>
            <h2 className="text-lg font-extrabold">Manage it from your account</h2>
            <p className="mt-2 text-[15px] leading-[1.55] text-ink-soft">See devices, renewals, invoices and downloads any time.</p>
            <Link href={CUSTOMER_HOME} className={CTA}>
              Go to my account
            </Link>
          </>
        ) : (
          <>
            <h2 className="text-lg font-extrabold">Keep your licenses in one place</h2>
            <p className="mt-2 text-[15px] leading-[1.55] text-ink-soft">
              {canClaim ? "Create an account" : "Sign in"} with {email} to see this purchase, download updates and manage
              devices.
            </p>
            {canClaim ? (
              <Link
                href={`/register?next=${encodeURIComponent(orderPath)}`}
                className={CTA}
                onClick={() => saveRegisterPrefill(email)}
              >
                Create account
              </Link>
            ) : (
              <Link href={signInPath(orderPath)} className={CTA}>
                Sign in
              </Link>
            )}
          </>
        )}
      </div>
    </section>
  );
}
