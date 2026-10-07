"use client";

import type * as React from "react";
import Link from "next/link";
import { Price, TaxNote } from "@/components/store/price";
import { DisabledAction, PermissionAction } from "@/components/account/disabled-action";
import { cn } from "@/lib/utils";
import type { RenewalOptionView } from "./data";
import { renewalCardCopy } from "./model";

const CTA = "mt-2 h-10 w-full cursor-pointer rounded-10 px-3 text-[16px] font-bold leading-[normal] transition-colors";
const CTA_PRIMARY = cn(CTA, "border-0 bg-primary text-white hover:bg-primary-hover");
const CTA_OUTLINE = cn(CTA, "border border-line-input bg-surface text-ink hover:border-primary");

/** New copy where the prototype rendered an empty grid. */
export const NO_OPTIONS_REVOKED = "Revoked licenses can’t be renewed or upgraded.";
export const NO_OPTIONS = "There are no renewal or upgrade options for this license right now.";
export const ADDON_UNAVAILABLE = "Computers can be added to active licenses only.";

/**
 * Renew & upgrade tab (prototype): one card per option with tag, title, body, price (excl. or incl. GST, as the
 * visitor's price display) and a button. Buying needs the purchases permission (Owner, Billing admin); others see
 * the buttons disabled with "Requires Owner or Billing admin".
 */
export function LicenseRenewTab({
  options,
  deviceLimit,
  revoked,
  canBuy,
  supportHref,
  onCart,
  onAddComputers,
  onChoosePlan,
}: {
  options: readonly RenewalOptionView[];
  deviceLimit: number;
  revoked: boolean;
  canBuy: boolean;
  /** New ticket about this license. */
  supportHref: string;
  onCart: (option: RenewalOptionView) => void;
  onAddComputers: () => void;
  onChoosePlan: () => void;
}) {
  if (options.length === 0) {
    return (
      <div className="rounded-16 border border-line-alt bg-surface px-[18px] py-6 text-[14.5px] text-ink-2">
        {revoked ? NO_OPTIONS_REVOKED : NO_OPTIONS}{" "}
        <PermissionAction perm="tickets.create">
          <Link href={supportHref} className="rounded-6 font-bold text-primary-link hover:text-primary-link-hover">
            Contact support
          </Link>
        </PermissionAction>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,250px),1fr))] gap-3.5">
      {options.map((option, index) => {
        const copy = renewalCardCopy(option, { deviceLimit });
        const primary = index === 0 && (option.tag === "RENEWAL" || option.tag === "MAINTENANCE" || option.tag === "BUY");
        const className = primary ? CTA_PRIMARY : CTA_OUTLINE;
        const run = copy.action === "addon" ? onAddComputers : copy.action === "choose" ? onChoosePlan : () => onCart(option);
        let button: React.ReactElement;
        if (!canBuy) {
          button = (
            <DisabledAction perm="purchases" asChild>
              <button type="button" className={className}>
                {copy.cta}
              </button>
            </DisabledAction>
          );
        } else if (!option.available) {
          button = (
            <DisabledAction perm="purchases" reason={ADDON_UNAVAILABLE} asChild>
              <button type="button" className={className}>
                {copy.cta}
              </button>
            </DisabledAction>
          );
        } else {
          button = (
            <button type="button" onClick={run} className={className}>
              {copy.cta}
            </button>
          );
        }
        return (
          <section
            key={`${option.tag}:${option.planId}`}
            aria-labelledby={`renew-${index}`}
            className={cn(
              "flex flex-col gap-1.5 rounded-16 bg-surface p-[18px]",
              primary ? "border-2 border-primary" : "border border-line-alt",
            )}
          >
            <span
              className={cn(
                "self-start rounded-[7px] px-2 py-[3px] text-[11.5px] font-extrabold tracking-[0.06em]",
                primary ? "bg-lavender-bg text-lavender-fg" : "bg-slate-bg text-ink-2",
              )}
            >
              {option.tag}
            </span>
            <h3 id={`renew-${index}`} className="m-0 mt-1 text-[16px] font-extrabold leading-[normal]">
              {copy.title}
            </h3>
            <p className="m-0 flex-1 text-[13.5px] leading-[1.55] text-ink-2">{copy.body}</p>
            <p className="m-0 mt-1.5 text-[22px] font-extrabold leading-[normal]">
              <Price paise={option.unitPricePaise} qty={option.qty} />{" "}
              <span className="text-[12.5px] font-semibold text-ink-2">
                <TaxNote excl={`${copy.unit} + GST`} incl={`${copy.unit} incl. GST`} />
              </span>
            </p>
            {button}
          </section>
        );
      })}
    </div>
  );
}
