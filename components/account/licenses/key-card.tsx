"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons/icon";
import { toast } from "@/components/ui/sonner";
import { DisabledAction } from "@/components/account/disabled-action";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { LICENSE_ACTION_ERRORS } from "@/lib/validation/license-actions";
import { cn } from "@/lib/utils";
import { DIALOG_INPUT, DIALOG_LABEL, PortalDialog } from "./portal-dialog";

/** Longest time a revealed key stays on screen (the server's hideAt is the authority, capped here too). */
export const KEY_VISIBLE_MS = 60_000;

const KEY_BUTTON =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-9 px-3 py-2 text-[13.5px] font-bold leading-[normal] transition-colors";

function revealError(error: unknown): string {
  if (error instanceof ApiClientError) return error.status === 401 ? "Sign in again." : error.message;
  return UNEXPECTED_ERROR_MESSAGE;
}

/**
 * "License key" card (prototype): the masked key; Reveal asks for the account password ("Confirm it’s you"), POSTs
 * /api/account/licenses/:id/reveal and shows the key until hideAt (60 s) or Hide; Copy puts it on the clipboard.
 * The key lives only in this component's state: never in the URL, storage, toasts or logs.
 */
export function KeyCard({
  licenseId,
  keyMasked,
  revoked,
  canReveal,
}: {
  licenseId: string;
  keyMasked: string;
  revoked: boolean;
  /** The member's role holds keys.reveal (Owner, Technical contact). */
  canReveal: boolean;
}) {
  const router = useRouter();
  const passwordId = React.useId();
  const [revealed, setRevealed] = React.useState<{ key: string; hideAt: number } | null>(null);
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");

  React.useEffect(() => {
    if (!revealed) return;
    const ms = Math.min(KEY_VISIBLE_MS, Math.max(0, revealed.hideAt - Date.now()));
    const timer = window.setTimeout(() => {
      setRevealed(null);
      setAnnouncement("The license key is hidden again.");
    }, ms);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setPassword("");
      setError(null);
    }
  };

  const reveal = async () => {
    if (password === "") {
      setError(LICENSE_ACTION_ERRORS.password);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ key: string; hideAt: string }>(`/api/account/licenses/${encodeURIComponent(licenseId)}/reveal`, {
        method: "POST",
        body: { password },
      });
      const hideAt = Math.min(Date.parse(result.hideAt) || 0, Date.now() + KEY_VISIBLE_MS);
      setBusy(false);
      setPassword("");
      setOpen(false);
      setRevealed({ key: result.key, hideAt });
      setAnnouncement("License key revealed. It hides again after 60 seconds.");
      // The Activity tab gains "Key revealed".
      router.refresh();
    } catch (cause) {
      setBusy(false);
      setPassword("");
      setError(revealError(cause));
    }
  };

  const copy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.key);
      toast.success("License key copied");
    } catch {
      toast.error("Couldn’t copy the key. Select it and copy it instead.");
    }
  };

  const hide = () => {
    setRevealed(null);
    setAnnouncement("The license key is hidden again.");
  };

  const revealButton = (
    <button
      type="button"
      onClick={revealed ? hide : () => setOpen(true)}
      className={cn(KEY_BUTTON, "border border-line-input bg-surface text-ink hover:border-primary")}
    >
      <Icon name={revealed ? "visibility_off" : "visibility"} size={17} />
      {revealed ? "Hide" : "Reveal"}
    </button>
  );

  return (
    <section aria-labelledby={`${passwordId}-title`} className="rounded-16 border border-line-alt bg-surface px-[18px] py-4">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <h2 id={`${passwordId}-title`} className="m-0 text-[15px] font-extrabold">
          License key
        </h2>
        <span className="text-[12.5px] font-semibold text-ink-2">Password required to reveal · auto-hides after 60 s</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-12 border border-line-subtle bg-bg px-3.5 py-3">
        <code
          translate="no"
          className={cn(
            "min-w-0 flex-[1_1_260px] break-all font-mono text-[15px] tracking-[0.05em] text-ink",
            revealed && "select-all",
          )}
        >
          {revealed ? revealed.key : keyMasked}
        </code>
        {revoked ? null : canReveal ? (
          revealButton
        ) : (
          <DisabledAction perm="keys.reveal" asChild>
            <button type="button" className={cn(KEY_BUTTON, "border border-line-input bg-surface text-ink")}>
              <Icon name="visibility" size={17} />
              Reveal
            </button>
          </DisabledAction>
        )}
        {revealed ? (
          <button type="button" onClick={() => void copy()} className={cn(KEY_BUTTON, "bg-primary text-white hover:bg-primary-hover")}>
            <Icon name="content_copy" size={17} />
            Copy
          </button>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <PortalDialog
        open={open}
        onOpenChange={close}
        title="Confirm it’s you"
        description="Enter your account password to reveal the full key. This is recorded in the activity log."
        confirmLabel="Reveal key"
        onConfirm={() => void reveal()}
        busy={busy}
        error={error}
      >
        <label htmlFor={passwordId} className={DIALOG_LABEL}>
          Password
          <input
            id={passwordId}
            type="password"
            value={password}
            autoComplete="current-password"
            aria-invalid={error ? true : undefined}
            onChange={(event) => setPassword(event.target.value)}
            className={DIALOG_INPUT}
          />
        </label>
      </PortalDialog>
    </section>
  );
}
