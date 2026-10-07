"use client";

import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { toIconName } from "@/components/store/active-nav";
import { orderPath } from "@/components/account/portal-nav";
import { formatDateIST } from "@/lib/dates";
import type { AccountLicenseDetail } from "@/lib/licensing/account";
import { cn } from "@/lib/utils";
import { historyLine, licenseFacts, statusExplanation } from "./model";
import { TONE_CALLOUT_CLASSES, TONE_TEXT_CLASSES } from "./ui";

type License = AccountLicenseDetail["license"];

/** Overview tab: status explanation, facts grid, the key card and the license actions (prototype order). */
export function LicenseOverviewTab({
  license,
  now,
  keyCard,
  actions,
}: {
  license: License;
  now: Date;
  keyCard: React.ReactNode;
  actions: React.ReactNode;
}) {
  const explanation = statusExplanation(license, now);
  const facts = licenseFacts(license, now);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className={cn("flex gap-3 rounded-14 border px-4 py-3.5", TONE_CALLOUT_CLASSES[explanation.tone])}>
        <Icon name={toIconName(explanation.icon)} size={22} className={cn("mt-px", TONE_TEXT_CLASSES[explanation.tone])} />
        <div className="min-w-0">
          <h2 className="m-0 text-[16px] font-extrabold leading-[normal]">{explanation.title}</h2>
          <p className="mb-0 mt-1 text-[14.5px] leading-[1.6] text-ink-soft">{explanation.body}</p>
        </div>
      </div>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] overflow-hidden rounded-16 border border-line-alt bg-surface">
        {facts.map((fact) => (
          <div key={fact.key} className="border-b border-r border-line-subtle px-4 py-3.5">
            <dt className="text-[11.5px] font-extrabold uppercase tracking-[0.06em] text-ink-2">{fact.label}</dt>
            <dd className="m-0 mt-1 text-[15px] font-extrabold">{fact.value}</dd>
            {fact.sub ? (
              <dd className="m-0 text-[12.5px] font-semibold text-ink-2">
                {fact.orderId ? (
                  // Order pages carry their own CSP (Razorpay): a full page load, not a client navigation.
                  <a href={orderPath(fact.orderId)} className="rounded-6 text-ink-2 no-underline hover:text-primary-link-hover hover:underline">
                    {fact.sub}
                  </a>
                ) : (
                  fact.sub
                )}
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
      {keyCard}
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

/** Activity tab: the license's events, newest first (routine validations are never recorded). */
export function LicenseActivityTab({ history, userName }: { history: AccountLicenseDetail["history"]; userName: string }) {
  return (
    <section aria-label="License activity" className="rounded-16 border border-line-alt bg-surface px-[18px] pb-3 pt-1.5">
      {history.length === 0 ? (
        <p className="m-0 py-5 text-[14px] text-ink-2">No activity recorded for this license yet.</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {history.map((entry) => {
            const line = historyLine(entry, userName);
            return (
              <li key={entry.id} className="grid grid-cols-[minmax(110px,160px)_1fr] gap-3 border-b border-line-subtle py-3 text-[13.5px]">
                <time dateTime={entry.at} className="font-semibold text-ink-2">
                  {formatDateIST(new Date(entry.at))}
                </time>
                <span className="min-w-0 break-words">
                  <strong className="font-bold">{line.what}</strong>
                  {line.who ? <span className="text-ink-2"> · {line.who}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
