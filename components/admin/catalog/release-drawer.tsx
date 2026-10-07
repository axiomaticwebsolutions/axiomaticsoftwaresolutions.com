"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useAdmin } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { AdminDrawer } from "@/components/admin/drawer";
import { SectionRow, SectionRows } from "@/components/admin/section";
import { StatusBadge } from "@/components/admin/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { platformList, releaseChannelLabel } from "@/lib/admin/catalog/model";
import type { AdminReleaseDetail } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { formatDateIST } from "@/lib/dates";
import { InstallerRows } from "./installer-upload";
import { ReleaseEditForm } from "./release-form";
import { useDetail } from "./shared";

type Props = {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Signed download link lifetime in minutes (settings and env). */
  linkMinutes: number;
  onChanged: () => void;
  onDeleted: () => void;
};

type Confirm = null | "publish" | "withdraw" | "delete";

function subtitleOf(r: AdminReleaseDetail): string {
  return r.releasedAt ? formatDateIST(new Date(r.releasedAt)) : `Draft \u00B7 created ${formatDateIST(new Date(r.createdAt))}`;
}

function factsOf(r: AdminReleaseDetail, linkMinutes: number) {
  return [
    { label: "Product", value: r.productFullName },
    { label: "Version", value: r.version, mono: true },
    { label: "Channel", value: releaseChannelLabel(r.channel) },
    { label: "Min. eligibility", value: r.releasedAt ? `Updates active on ${formatDateIST(new Date(r.releasedAt))}` : "Updates active on the publish date" },
    { label: "Storage path", value: `/${r.storagePrefix}`, mono: true },
    { label: "Signed link TTL", value: `${linkMinutes} ${linkMinutes === 1 ? "minute" : "minutes"}` },
  ];
}

function NotesSection({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <SectionRows aria-label="Release notes">
      {notes.map((note, i) => (
        <SectionRow key={`${i}:${note}`} title={note} />
      ))}
    </SectionRows>
  );
}

/** Publish consequence: the prototype sentence, plus channel and missing-installer warnings. */
function publishCopy(r: AdminReleaseDetail | null): string {
  if (!r) return "";
  const channel = r.channel !== "stable" ? " It isn\u2019t on the Stable channel, so customers won\u2019t see it." : "";
  const missing = r.missingPlatforms.length > 0 ? ` No ${platformList(r.missingPlatforms, " or ")} installer is uploaded yet.` : "";
  return `Eligible customers will see it in My Software and get an update notification.${channel}${missing}`;
}

/**
 * Release drawer (Admin Console.dc.html releases detail): facts, "Release details" (releases.manage), installers
 * with presigned uploads for drafts, release notes, and Publish release / Delete draft (drafts) or Withdraw release
 * (published; reason, audited).
 */
export function ReleaseDrawer({ id, open, onOpenChange, linkMinutes, onChanged, onDeleted }: Props) {
  const { can } = useAdmin();
  const canManage = can("releases.manage");
  const detail = useDetail(id ? `/api/admin/releases/${encodeURIComponent(id)}` : null, (b) => (b as { release: AdminReleaseDetail }).release);
  const [confirm, setConfirm] = React.useState<Confirm>(null);
  const r = detail.data;
  const saved = (next: AdminReleaseDetail) => {
    detail.set(next);
    onChanged();
  };
  const base = r ? `/api/admin/releases/${encodeURIComponent(r.id)}` : "";
  const confirmProps = (key: Exclude<Confirm, null>) => ({ open: confirm === key, onOpenChange: (o: boolean) => setConfirm(o ? key : null) });

  async function publish() {
    const res = await apiFetch<{ release: AdminReleaseDetail }>(`${base}/publish`, { method: "POST", body: {} });
    adminToast.success("Release published");
    saved(res.release);
  }
  async function withdraw(reason: string) {
    const res = await apiFetch<{ release: AdminReleaseDetail }>(`${base}/withdraw`, { method: "POST", body: { reason } });
    adminToast.success("Release withdrawn");
    saved(res.release);
  }
  async function remove(reason: string) {
    await apiFetch(base, { method: "DELETE", body: { reason } });
    adminToast.success("Draft release deleted");
    onChanged();
    onDeleted();
  }

  const draft = r?.rawStatus === "DRAFT";
  const withdrawn = r?.rawStatus === "WITHDRAWN";
  const readOnly = !canManage || withdrawn;
  const version = r?.version ?? "";
  return (
    <>
      <AdminDrawer
        open={open}
        onOpenChange={onOpenChange}
        kind="Release"
        title={r ? `${r.productName} v${r.version}` : (id ?? "Release")}
        subtitle={r ? subtitleOf(r) : undefined}
        status={r ? <StatusBadge kind="release" status={r.status} /> : undefined}
        loading={detail.loading}
        error={detail.error}
        fields={r ? factsOf(r, linkMinutes) : undefined}
        edit={
          r
            ? {
                title: "Release details",
                readOnly,
                readOnlyNote: canManage && withdrawn ? "Withdrawn releases can\u2019t be edited" : undefined,
                form: <ReleaseEditForm key={`${r.id}:${r.version}:${r.rawStatus}:${r.notes.join("|")}`} release={r} readOnly={readOnly} onSaved={saved} />,
              }
            : undefined
        }
        sections={
          r
            ? [
                { id: "installers", title: "Installers", content: <InstallerRows release={r} onChanged={saved} /> },
                { id: "notes", title: "Release notes", empty: "No release notes yet.", content: r.notes.length > 0 ? <NotesSection notes={r.notes} /> : null },
              ]
            : undefined
        }
        footer={
          r && !withdrawn ? (
            draft ? (
              <>
                <AdminAction
                  perm="releases.manage"
                  variant="primary"
                  size="sm"
                  icon="rocket_launch"
                  disabledReason={r.fileCount === 0 ? "Upload at least one installer before publishing" : undefined}
                  onClick={() => setConfirm("publish")}
                  aria-haspopup="dialog"
                >
                  Publish release
                </AdminAction>
                <AdminAction perm="releases.manage" variant="danger" size="sm" icon="delete" onClick={() => setConfirm("delete")} aria-haspopup="dialog">
                  Delete draft
                </AdminAction>
              </>
            ) : (
              <AdminAction perm="releases.manage" variant="danger" size="sm" icon="block" onClick={() => setConfirm("withdraw")} aria-haspopup="dialog">
                Withdraw release
              </AdminAction>
            )
          ) : undefined
        }
      />
      <ConfirmDialog
        {...confirmProps("publish")}
        title={`Publish v${version}?`}
        description={publishCopy(r)}
        confirmLabel="Publish"
        tone="primary"
        icon="rocket_launch"
        requireReason={false}
        onConfirm={publish}
      />
      <ConfirmDialog
        {...confirmProps("withdraw")}
        title={`Withdraw v${version}?`}
        description="Customers can no longer see or download it. If it was the latest version, the previous release becomes the latest."
        confirmLabel="Withdraw release"
        tone="danger"
        icon="block"
        onConfirm={({ reason }) => withdraw(reason)}
      />
      <ConfirmDialog
        {...confirmProps("delete")}
        title={`Delete the draft of v${version}?`}
        description="The draft and its uploaded installers are removed. Published releases can’t be deleted."
        confirmLabel="Delete draft"
        tone="danger"
        icon="delete"
        onConfirm={({ reason }) => remove(reason)}
      />
    </>
  );
}
