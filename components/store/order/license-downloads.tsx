"use client";

import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import {
  downloadButtonLabel,
  downloadLinkCreatedMessage,
  downloadLinkNote,
  downloadOptionFor,
  TEAM_CANNOT_DOWNLOAD_MESSAGE,
  type DownloadLinkResponse,
  type DownloadReleaseView,
} from "@/lib/downloads/model";
import type { OrderStatusLicense } from "@/lib/orders/status";
import { orderPaths, type OrderViewer } from "./order-model";

/** Members of the order's account download through the portal endpoint (their best license, their activity log). */
export const ACCOUNT_DOWNLOADS_PATH = "/api/account/downloads";

export type LicenseDownloadsProps = {
  license: Pick<OrderStatusLicense, "status" | "expiresAt" | "updatesUntil">;
  /** Published releases of the license's product, newest first. */
  releases: readonly DownloadReleaseView[];
  orderId: string;
  /** Order link token (guests), or null. */
  token: string | null;
  viewer: OrderViewer;
  downloadLinkMinutes: number;
};

const NOTE = "text-[13.5px] font-semibold text-ink-2";

/** Only http(s) URLs are followed (the server returns S3/CDN or the dev storage route). */
function safeDownloadUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Order.dc.html download row: one button per installer of the newest release this license may download
 * ("Download v4.2.1 · 148 MB"), with "Secure link · expires 10 minutes after you click". A click asks the server for a
 * presigned link (the guest endpoint with the order token, or /api/account/downloads for members who may download)
 * and hands it to the browser, which saves the file (Content-Disposition: attachment). Errors use the API's copy.
 */
export function LicenseDownloads({ license, releases, orderId, token, viewer, downloadLinkMinutes }: LicenseDownloadsProps) {
  const [now] = React.useState(() => Date.now());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const option = React.useMemo(() => downloadOptionFor(license, releases, new Date(now)), [license, releases, now]);

  if (viewer.member && !viewer.canDownload) {
    return (
      <div className="mt-3.5 print:hidden">
        <p className={NOTE}>{TEAM_CANNOT_DOWNLOAD_MESSAGE}</p>
      </div>
    );
  }
  if (!option.ok) {
    return (
      <div className="mt-3.5 print:hidden">
        <p className={NOTE}>{option.message}</p>
      </div>
    );
  }

  const { release } = option;
  const several = release.files.length > 1;
  const viaAccount = viewer.member && viewer.canDownload;

  async function download(fileId: string) {
    if (busy) return;
    setBusy(fileId);
    setError(null);
    try {
      const link = viaAccount
        ? await apiFetch<DownloadLinkResponse>(ACCOUNT_DOWNLOADS_PATH, { body: { releaseFileId: fileId } })
        : await apiFetch<DownloadLinkResponse>(orderPaths(orderId, null).downloads, {
            body: token ? { releaseFileId: fileId, t: token } : { releaseFileId: fileId },
          });
      const url = safeDownloadUrl(link.url);
      if (!url) throw new ApiClientError(502, "invalid_response", UNEXPECTED_ERROR_MESSAGE);
      toast(downloadLinkCreatedMessage(downloadLinkMinutes));
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3.5 print:hidden">
      <div className="flex flex-wrap items-center gap-2.5">
        {release.files.map((file) => (
          <Button
            key={file.id}
            type="button"
            variant="secondary"
            // Long labels ("Download v3.1.0 for Windows · 64 MB") wrap inside the button on narrow phones.
            className="max-w-full shrink whitespace-normal rounded-12 px-4 py-[11px] text-left text-base leading-[normal]"
            loading={busy === file.id}
            loadingText="Creating link…"
            onClick={() => void download(file.id)}
          >
            <Icon name="download" size={20} />
            {downloadButtonLabel(release.version, file, several)}
          </Button>
        ))}
        <span className={NOTE}>{downloadLinkNote(downloadLinkMinutes)}</span>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[13.5px] font-semibold text-pink-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
