"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { adminToast, errorMessage } from "@/components/admin/admin-toaster";
import { SectionRows } from "@/components/admin/section";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { INSTALLER_EXTENSIONS, installerExtensionError, PLATFORM_LABELS, shortSha256 } from "@/lib/admin/catalog/model";
import { MAX_INSTALLER_BYTES } from "@/lib/admin/catalog/schemas";
import type { AdminReleaseDetail, AdminReleaseFile, CatalogPlatform, InstallerConfirmResult, InstallerUploadTicket } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { formatFileSize } from "@/lib/storefront/derive";
import { cn } from "@/lib/utils";

const INTERRUPTED = "The upload was interrupted. Check your connection and try again.";

/** PUTs the file to the presigned URL with exactly the signed headers, reporting progress (0-100). */
function putWithProgress(upload: InstallerUploadTicket["upload"], file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url);
    for (const [name, value] of Object.entries(upload.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 403 ? "The upload link expired. Try again." : INTERRUPTED)));
    xhr.onerror = () => reject(new Error(INTERRUPTED));
    xhr.onabort = () => reject(new Error(INTERRUPTED));
    xhr.send(file);
  });
}

type Phase = { kind: "idle" } | { kind: "uploading"; pct: number } | { kind: "checking" } | { kind: "error"; message: string };

type RowProps = {
  release: AdminReleaseDetail;
  platform: CatalogPlatform;
  file: AdminReleaseFile | undefined;
  onChanged: (release: AdminReleaseDetail) => void;
};

function InstallerRow({ release, platform, file, onChanged }: RowProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const draft = release.rawStatus === "DRAFT";
  const busy = phase.kind === "uploading" || phase.kind === "checking";
  const label = PLATFORM_LABELS[platform];
  const base = `/api/admin/releases/${encodeURIComponent(release.id)}`;

  async function upload(chosen: File) {
    const invalid = installerExtensionError(platform, chosen.name) ?? (chosen.size > MAX_INSTALLER_BYTES ? "Installers can be up to 2 GB." : chosen.size === 0 ? "This file is empty." : null);
    if (invalid) {
      setPhase({ kind: "error", message: invalid });
      return;
    }
    setPhase({ kind: "uploading", pct: 0 });
    try {
      const ticket = await apiFetch<InstallerUploadTicket>(`${base}/files`, { method: "POST", body: { platform, fileName: chosen.name, sizeBytes: chosen.size } });
      await putWithProgress(ticket.upload, chosen, (pct) => setPhase({ kind: "uploading", pct }));
      setPhase({ kind: "checking" });
      const res = await apiFetch<InstallerConfirmResult>(`${base}/files/confirm`, { method: "POST", body: { uploadToken: ticket.uploadToken } });
      setPhase({ kind: "idle" });
      adminToast.success(`${label} installer uploaded`);
      onChanged(res.release);
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error && !(error as { code?: string }).code ? error.message : errorMessage(error) });
    }
  }

  async function remove(reason: string) {
    if (!file) return;
    const res = await apiFetch<{ release: AdminReleaseDetail }>(`${base}/files/${encodeURIComponent(file.id)}`, { method: "DELETE", body: { reason } });
    adminToast.success(`${label} installer removed`);
    onChanged(res.release);
  }

  const detail =
    phase.kind === "uploading" ? (
      <span>
        Uploading {phase.pct}%
        <span role="progressbar" aria-label={`Uploading the ${label} installer`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase.pct} className="mt-1 block h-1 w-full max-w-[220px] overflow-hidden rounded-[2px] bg-line-subtle forced-color-adjust-none">
          <span className="block h-full bg-primary transition-[width]" style={{ width: `${phase.pct}%` }} />
        </span>
      </span>
    ) : phase.kind === "checking" ? (
      "Checking the file and computing its SHA-256\u2026"
    ) : phase.kind === "error" ? (
      <span className="text-danger">{phase.message}</span>
    ) : file ? (
      <span title={`SHA-256 ${file.sha256}`}>
        {label} {"\u00B7"} {formatFileSize(file.sizeBytes)} {"\u00B7"} SHA-256 <span className="font-mono">{shortSha256(file.sha256)}</span>
      </span>
    ) : (
      `${label} \u00B7 ${INSTALLER_EXTENSIONS[platform].join(", ")}`
    );

  const actions = draft ? (
    <>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept={INSTALLER_EXTENSIONS[platform].join(",")}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = "";
          if (chosen) void upload(chosen);
        }}
      />
      <AdminAction perm="releases.manage" size="xs" icon="upload" busy={busy} onClick={() => inputRef.current?.click()} aria-label={`${file ? "Replace" : "Upload"} the ${label} installer`}>
        {file ? "Replace" : "Upload"}
      </AdminAction>
      {file ? (
        <AdminAction perm="releases.manage" size="xs" icon="delete" variant="danger" onClick={() => setConfirmRemove(true)} aria-label={`Remove the ${label} installer`}>
          Remove
        </AdminAction>
      ) : null}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove the ${label} installer?`}
        description="The file is deleted from storage. You can upload it again while the release is a draft."
        confirmLabel="Remove"
        tone="danger"
        icon="delete"
        onConfirm={({ reason }) => remove(reason)}
      />
    </>
  ) : null;

  // SectionRow layout, but the status and actions wrap under the file name in a phone-width drawer.
  return (
    <li className="grid gap-2 border-b border-line-subtle px-3 py-[9px] text-[13px] last:border-b-0 min-[35rem]:flex min-[35rem]:items-center min-[35rem]:gap-2.5">
      <div className="min-w-0 flex-1">
        <div className="break-words font-bold">{file?.fileName ?? `${label} installer`}</div>
        <div aria-live="polite" className="break-words text-[12px] font-semibold text-ink-2">
          {detail}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn("whitespace-nowrap text-[12px] font-bold", file ? "text-sage-fg" : "text-ink-2")}>{file ? "Uploaded" : "Not uploaded"}</span>
        {actions}
      </div>
    </li>
  );
}

/** The drawer's "Installers" section: one row per platform the product supports (plus any other uploaded file). */
export function InstallerRows({ release, onChanged }: { release: AdminReleaseDetail; onChanged: (release: AdminReleaseDetail) => void }) {
  const platforms = [...release.productPlatforms, ...release.files.map((f) => f.platform).filter((p) => !release.productPlatforms.includes(p))];
  return (
    <SectionRows aria-label="Installers">
      {platforms.map((p) => (
        <InstallerRow key={p} release={release} platform={p} file={release.files.find((f) => f.platform === p)} onChanged={onChanged} />
      ))}
    </SectionRows>
  );
}
