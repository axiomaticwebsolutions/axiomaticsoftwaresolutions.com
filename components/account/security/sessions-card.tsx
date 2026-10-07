"use client";

import * as React from "react";
import { PortalConfirmDialog } from "@/components/account/team/portal-confirm-dialog";
import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { CardHeading, SECURITY_CARD, SECURITY_SMALL_BUTTON } from "./security-parts";
import {
  hasOtherSessions,
  SECURITY_COPY,
  SESSIONS_VISIBLE,
  sessionIcon,
  sessionMeta,
  showMoreSessionsLabel,
  signedOutToast,
  type SessionView,
} from "./security-model";

export type SessionsCardProps = {
  sessions: SessionView[];
  now: Date;
  /** Re-read the list after a change. */
  onChanged: () => Promise<void> | void;
};

function messageOf(error: unknown): string {
  return error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE;
}

/**
 * "Active sessions" (prototype): device ("Chrome on Windows"), truncated IP and "Active now" / "Last active {rel}",
 * "This device" on the current one and "Sign out" on the others. "Sign out all others" asks for confirmation first
 * (decisions.md Phase 5). The API logs "Signed out session" / "Signed out all other sessions".
 */
export function SessionsCard({ sessions, now, onChanged }: SessionsCardProps) {
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const listRef = React.useRef<HTMLUListElement>(null);

  function revealAll() {
    setShowAll(true);
    // The button goes away: continue at the first session that was hidden.
    window.requestAnimationFrame(() => {
      listRef.current?.children[SESSIONS_VISIBLE]?.querySelector<HTMLElement>("button")?.focus();
    });
  }
  const focusTarget = React.useRef<HTMLSpanElement>(null);

  async function signOut(session: SessionView) {
    if (revoking) return;
    setRevoking(session.id);
    try {
      const result = await apiFetch<{ device: string }>(`/api/me/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      toast.success(signedOutToast(result.device || session.device));
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setRevoking(null);
    }
    await onChanged();
    // The row (and its button) is gone: keep keyboard focus in the card.
    focusTarget.current?.focus();
  }

  async function signOutOthers() {
    await apiFetch<{ revoked: number }>("/api/me/sessions", { method: "DELETE" });
    toast.success(SECURITY_COPY.othersSignedOut);
    await onChanged();
  }

  const others = hasOtherSessions(sessions);
  const visible = showAll ? sessions : sessions.slice(0, SESSIONS_VISIBLE);
  const hidden = sessions.length - visible.length;

  return (
    <section aria-labelledby="security-sessions-heading" className={SECURITY_CARD}>
      <CardHeading
        id="security-sessions-heading"
        action={
          others ? (
            <Button type="button" variant="destructive-outline" className={SECURITY_SMALL_BUTTON} onClick={() => setConfirmOpen(true)}>
              {SECURITY_COPY.signOutOthers}
            </Button>
          ) : null
        }
      >
        <span ref={focusTarget} tabIndex={-1} className="outline-none">
          {SECURITY_COPY.sessionsHeading}
        </span>
      </CardHeading>
      <ul ref={listRef} className="m-0 list-none divide-y divide-line-subtle p-0">
        {visible.map((session) => {
          const meta = sessionMeta(session, now);
          return (
            <li key={session.id} className="flex flex-wrap items-center gap-3 px-[18px] py-3">
              <Icon name={sessionIcon(session)} size={21} className="shrink-0 text-ink-2" />
              <div className="min-w-0 flex-[1_1_180px]">
                <p className="m-0 text-[14px] font-bold">{session.device}</p>
                <p className="m-0 mt-0.5 text-[12.5px] font-semibold text-ink-2">{meta}</p>
              </div>
              {session.current ? (
                <Badge tone="sage" className="px-2 py-0.5 text-[11.5px] leading-[normal]">
                  {SECURITY_COPY.thisDevice}
                </Badge>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  className={SECURITY_SMALL_BUTTON}
                  loading={revoking === session.id}
                  aria-label={`${SECURITY_COPY.signOut} ${session.device} (${meta})`}
                  onClick={() => void signOut(session)}
                >
                  {SECURITY_COPY.signOut}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <div className="border-t border-line-subtle px-[18px] py-2.5">
          <button
            type="button"
            onClick={revealAll}
            className="cursor-pointer rounded-6 text-[13px] font-bold text-primary-link hover:text-primary-link-hover hover:underline"
          >
            {showMoreSessionsLabel(hidden)}
          </button>
        </div>
      ) : null}
      <PortalConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={SECURITY_COPY.signOutOthersTitle}
        description={SECURITY_COPY.signOutOthersBody}
        confirmLabel={SECURITY_COPY.signOutOthers}
        tone="danger"
        onConfirm={signOutOthers}
        fallbackFocus={() => focusTarget.current}
      />
    </section>
  );
}
