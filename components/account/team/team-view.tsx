"use client";

import * as React from "react";
import type { TeamRole } from "@/generated/prisma/enums";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { InviteDialog } from "./invite-dialog";
import { MEMBERS_FOCUS_ID, MembersCard } from "./members-card";
import { PermissionMatrix } from "./permission-matrix";
import { PortalConfirmDialog } from "./portal-confirm-dialog";
import {
  removeDialogCopy,
  roleChangeDialogCopy,
  TEAM_COPY,
  type TeamMemberView,
  type TeamView as TeamData,
} from "./team-model";

export type TeamViewProps = {
  /** GET /api/account/team body, loaded by the server page. */
  initial: TeamData;
  businessName: string;
  /** Server time (ms) for the first render's relative times, so hydration matches. */
  now: number;
};

type Pending =
  | { kind: "role"; member: TeamMemberView; role: TeamRole }
  | { kind: "remove"; member: TeamMemberView };

function messageOf(error: unknown): string {
  return error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE;
}

const memberPath = (id: string) => `/api/account/team/${encodeURIComponent(id)}`;

/** A warning stays longer than the 3.2 s success toast: the Owner has to act on it. */
const WARNING_DURATION_MS = 10_000;

/** Invite / resend outcome: "Invitation sent to ..." or, when the email failed (`emailSent: false`), the warning. */
function toastInvitation(email: string, emailSent: boolean) {
  if (emailSent) toast.success(TEAM_COPY.invitationSent(email));
  else toast.warning(TEAM_COPY.invitationEmailFailed, { duration: WARNING_DURATION_MS });
}

/**
 * "Team & access" (Owner only; the page checks `team.manage` first): header with "Invite member", the members card
 * and the permission matrix. Every change goes through the team API and then re-reads the list; role changes and
 * removals ask for confirmation (decisions.md Phase 5). Toasts use the prototype copy.
 */
export function TeamView({ initial, businessName, now: serverNow }: TeamViewProps) {
  const [team, setTeam] = React.useState(initial);
  const [now, setNow] = React.useState(() => new Date(serverNow));
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [resending, setResending] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const next = await apiFetch<TeamData>("/api/account/team");
      setTeam(next);
      setNow(new Date());
    } catch (error) {
      toast.error(messageOf(error));
    }
  }, []);

  const ask = (next: Pending) => {
    setPending(next);
    setConfirmOpen(true);
  };

  async function confirm() {
    if (!pending) return;
    const { member } = pending;
    if (pending.kind === "role") {
      await apiFetch(memberPath(member.id), { method: "PATCH", body: { role: pending.role } });
      toast.success(TEAM_COPY.roleUpdated);
    } else {
      await apiFetch(memberPath(member.id), { method: "DELETE" });
      toast.success(TEAM_COPY.accessRemoved);
    }
    await reload();
  }

  async function resend(member: TeamMemberView) {
    if (resending) return;
    setResending(member.id);
    try {
      const result = await apiFetch<{ emailSent?: boolean }>(`${memberPath(member.id)}/resend`, { method: "POST" });
      toastInvitation(member.email, result.emailSent !== false);
      void reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setResending(null);
    }
  }

  const copy = pending
    ? pending.kind === "role"
      ? roleChangeDialogCopy(pending.member, pending.role)
      : removeDialogCopy(pending.member)
    : null;

  return (
    <>
      <PageHeader
        title={TEAM_COPY.title}
        description={TEAM_COPY.description}
        actions={
          <PageAction variant="primary" icon="person_add" onClick={() => setInviteOpen(true)}>
            {TEAM_COPY.invite}
          </PageAction>
        }
      />
      <div className="grid gap-4">
        <MembersCard
          team={team}
          now={now}
          resending={resending}
          onRoleChange={(member, role) => ask({ kind: "role", member, role })}
          onRemove={(member) => ask({ kind: "remove", member })}
          onResend={resend}
        />
        <PermissionMatrix />
      </div>
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        businessName={businessName}
        onInvited={(email, emailSent) => {
          toastInvitation(email, emailSent);
          void reload();
        }}
      />
      <PortalConfirmDialog
        open={confirmOpen && copy !== null}
        onOpenChange={setConfirmOpen}
        title={copy?.title ?? ""}
        description={copy?.body ?? ""}
        confirmLabel={copy?.cta ?? ""}
        tone={pending?.kind === "role" ? "primary" : "danger"}
        onConfirm={confirm}
        fallbackFocus={() => document.getElementById(MEMBERS_FOCUS_ID)}
      />
    </>
  );
}

