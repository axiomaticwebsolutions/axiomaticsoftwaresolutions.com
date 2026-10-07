"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { DisabledAction } from "@/components/account/disabled-action";
import { usePortal } from "@/components/account/portal-context";
import { iconOr } from "@/components/account/overview/model";
import { toneClasses } from "@/components/account/overview/tones";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import type { DownloadLinkResponse } from "@/lib/downloads/model";
import type { SoftwareProductView } from "@/lib/software/view";
import { cn } from "@/lib/utils";
import {
  downloadButtons,
  downloadToast,
  INSTALL_GUIDE_PATH,
  latestNote,
  licenseLine,
  lockNote,
  platformsText,
  renewHref,
  safeDownloadUrl,
  SOFTWARE_COPY,
  versionLabel,
  type DownloadButton,
} from "./model";
import { ReleaseNotes } from "./release-notes";

export const DOWNLOADS_API_PATH = "/api/account/downloads";

const OVERLINE = "text-[11.5px] font-extrabold uppercase tracking-[0.08em] text-ink-2";
const OUTLINE =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-10 border border-line-input bg-surface px-3.5 py-2 text-[13.5px] font-bold leading-[normal] text-ink no-underline transition-colors hover:border-primary hover:text-ink";

export type SoftwareProductCardProps = {
  product: SoftwareProductView;
  /** Download link lifetime in whole minutes (settings, at most 10). */
  linkMinutes: number;
};

/**
 * One product of "Software & downloads" (prototype article): product + license, ELIGIBLE VERSION, LATEST RELEASE and
 * the eligibility pill; a footer with a download button per installer of the eligible release, the renewal link, the
 * "Release notes" toggle, the installation guide and the lock note; the collapsible release-notes table.
 * Downloads: POST /api/account/downloads { releaseFileId } (entitlement-checked on the server), then the browser
 * follows the short-lived link. Roles without `downloads` / `purchases` see those actions disabled with a tooltip.
 */
export function SoftwareProductCard({ product, linkMinutes }: SoftwareProductCardProps) {
  const { can } = usePortal();
  const baseId = React.useId();
  const headingId = `${baseId}-name`;
  const noteId = `${baseId}-lock`;
  const notesId = `${baseId}-notes`;
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const tone = toneClasses(product.tone);
  const buttons = downloadButtons(product);
  const mayDownload = can("downloads");

  async function download(button: DownloadButton) {
    if (busy) return;
    setBusy(button.fileId);
    setError(null);
    try {
      const link = await apiFetch<DownloadLinkResponse>(DOWNLOADS_API_PATH, { body: { releaseFileId: button.fileId } });
      const url = safeDownloadUrl(link.url, window.location.href);
      if (!url) throw new ApiClientError(502, "invalid_response", UNEXPECTED_ERROR_MESSAGE);
      toast.success(downloadToast(link.version || button.version, linkMinutes));
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(null);
    }
  }

  return (
    <article aria-labelledby={headingId} className="overflow-hidden rounded-16 border border-line-alt bg-surface">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))]">
        <div className="flex items-center gap-3 border-r border-line-subtle p-[18px]">
          <span aria-hidden="true" className={cn("grid size-11 flex-none place-items-center rounded-13", tone.tile)}>
            <Icon name={iconOr(product.icon, "inventory_2")} size={24} />
          </span>
          <div className="min-w-0">
            <h2 id={headingId} className="m-0 text-[15.5px] font-extrabold">
              {product.name}
            </h2>
            <div className="mt-0.5 text-[12.5px] font-semibold text-ink-2">{licenseLine(product)}</div>
          </div>
        </div>
        <Fact label={SOFTWARE_COPY.eligibleVersion} value={product.eligibleRelease ? versionLabel(product.eligibleRelease.version) : SOFTWARE_COPY.none} note={product.eligibleNote} />
        <Fact label={SOFTWARE_COPY.latestRelease} value={product.latestRelease ? versionLabel(product.latestRelease.version) : SOFTWARE_COPY.none} note={latestNote(product.latestRelease)} />
        <div className="flex flex-col justify-center gap-2 p-[18px]">
          <span className={cn("self-start rounded-pill px-2.5 py-[3px] text-[12px] font-extrabold", toneClasses(product.eligibility.tone).tile)}>
            {product.eligibility.label}
          </span>
          <span className="text-[12.5px] font-semibold text-ink-2">{platformsText(product.platforms)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle bg-bg px-[18px] py-3">
        {buttons.map((button) =>
          mayDownload ? (
            <Button
              key={button.fileId}
              type="button"
              size="sm"
              className="gap-1.5 rounded-10 px-3.5 py-2.5 leading-[normal]"
              aria-describedby={noteId}
              loading={busy === button.fileId}
              loadingText={SOFTWARE_COPY.creatingLink}
              onClick={() => void download(button)}
            >
              {busy === button.fileId ? null : <Icon name="download" size={18} />}
              {button.label}
            </Button>
          ) : (
            <DisabledAction key={button.fileId} perm="downloads" asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-10 bg-primary px-3.5 py-2.5 text-[13.5px] font-bold leading-[normal] text-white"
              >
                <Icon name="download" size={18} />
                {button.label}
              </button>
            </DisabledAction>
          ),
        )}
        {product.needsRenewal && product.renewLabel ? (
          can("purchases") ? (
            <Link href={renewHref(product)} className={OUTLINE}>
              {product.renewLabel}
            </Link>
          ) : (
            <DisabledAction perm="purchases" asChild>
              <button type="button" className={OUTLINE}>
                {product.renewLabel}
              </button>
            </DisabledAction>
          )
        ) : null}
        {product.releases.length > 0 ? (
          <button
            type="button"
            aria-expanded={notesOpen}
            aria-controls={notesId}
            onClick={() => setNotesOpen((open) => !open)}
            className={OUTLINE}
          >
            {SOFTWARE_COPY.releaseNotes}
            <span className="sr-only">{` for ${product.shortName}`}</span>
          </button>
        ) : null}
        <Link
          href={INSTALL_GUIDE_PATH}
          className="rounded-6 px-1.5 py-2 text-[13.5px] font-bold text-primary-link underline hover:text-primary-link-hover"
        >
          {SOFTWARE_COPY.installGuide}
        </Link>
        <span id={noteId} className="ml-auto flex items-center gap-1 text-[12.5px] font-semibold text-ink-2">
          <Icon name="lock" size={16} />
          {lockNote(product, linkMinutes)}
        </span>
      </div>
      {error ? (
        <p role="alert" className="m-0 border-t border-line-subtle bg-pink-soft px-[18px] py-2.5 text-[13.5px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
      {product.releases.length > 0 ? (
        <ReleaseNotes id={notesId} hidden={!notesOpen} productName={product.name} releases={product.releases} />
      ) : null}
    </article>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="border-r border-line-subtle p-[18px]">
      <div className={OVERLINE}>{label}</div>
      <div className="mt-1 text-[20px] font-extrabold">{value}</div>
      <div className="text-[12.5px] font-semibold text-ink-2">{note}</div>
    </div>
  );
}
