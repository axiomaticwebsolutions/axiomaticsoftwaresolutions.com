"use client";

import * as React from "react";
import type { TeamRole } from "@/generated/prisma/enums";
import { RowSelect } from "@/components/account/row-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  lastActiveLabel,
  MEMBER_COLUMNS,
  memberAvatar,
  membersSummary,
  memberStatusBadge,
  memberTitle,
  removeLabel,
  roleOptionsFor,
  roleSelectLabel,
  TEAM_COPY,
  type TeamMemberView,
  type TeamView,
} from "./team-model";

export type MembersCardProps = {
  team: TeamView;
  now: Date;
  /** Member id whose resend is running. */
  resending: string | null;
  onRoleChange: (member: TeamMemberView, role: TeamRole) => void;
  onRemove: (member: TeamMemberView) => void;
  onResend: (member: TeamMemberView) => void;
};

/** Focus target after a removed member’s row (and its button) is gone. */
export const MEMBERS_FOCUS_ID = "team-members-focus";

const ROW_BUTTON = "h-auto rounded-9 px-3 py-1.5 text-[13px] leading-[normal]";

function Avatar({ member }: { member: TeamMemberView }) {
  const avatar = memberAvatar(member);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-pill text-[12px] font-extrabold",
        avatar.tone === "slate" ? "bg-slate-bg text-ink-2" : "bg-lavender-bg text-lavender-fg",
      )}
    >
      {avatar.text}
    </span>
  );
}

function StatusBadge({ member, now }: { member: TeamMemberView; now: Date }) {
  const badge = memberStatusBadge(member, now);
  return (
    <Badge tone={badge.tone} className="px-[9px] py-[3px] text-[12px] leading-[normal]">
      {badge.label}
    </Badge>
  );
}

/**
 * Role select (disabled on your own row). A listbox: arrow keys browse without choosing, so the confirmation opens
 * only for a role picked with Enter or a click (a native select changed on every arrow key in Chrome on Windows).
 */
function RoleSelect({ member, onRoleChange, className }: { member: TeamMemberView; onRoleChange: MembersCardProps["onRoleChange"]; className?: string }) {
  return (
    <RowSelect
      label={roleSelectLabel(member)}
      value={member.role}
      options={roleOptionsFor(member)}
      disabled={!member.canChangeRole}
      onValueChange={(next) => {
        if (next !== member.role) onRoleChange(member, next as TeamRole);
      }}
      className={cn("min-w-[150px] font-bold disabled:bg-bg disabled:text-ink-2 disabled:hover:border-line-strong", className)}
    />
  );
}

function RowActions({
  member,
  resending,
  onRemove,
  onResend,
  className,
}: Pick<MembersCardProps, "resending" | "onRemove" | "onResend"> & { member: TeamMemberView; className?: string }) {
  if (!member.canRemove) return null;
  const who = member.name.trim() || member.email;
  return (
    <span className={cn("inline-flex flex-wrap justify-end gap-2", className)}>
      {member.status === "invited" ? (
        <Button
          type="button"
          variant="secondary"
          className={ROW_BUTTON}
          loading={resending === member.id}
          aria-label={`${TEAM_COPY.resend} invite to ${member.email}`}
          onClick={() => onResend(member)}
        >
          {TEAM_COPY.resend}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="destructive-outline"
        className={ROW_BUTTON}
        aria-label={member.status === "invited" ? `${TEAM_COPY.revoke} for ${member.email}` : `${TEAM_COPY.remove} ${who}`}
        onClick={() => onRemove(member)}
      >
        {removeLabel(member)}
      </Button>
    </span>
  );
}

const TH = "py-2.5 font-extrabold";

/**
 * "Members · {n} active · {m} invited" (prototype): MEMBER (avatar, name or "Invitation pending", email), ROLE (select;
 * disabled on your own row), STATUS, LAST ACTIVE and Remove / Revoke invite (+ Resend for invitations; new). Below
 * 760px every member is a card with the same controls.
 */
export function MembersCard({ team, now, resending, onRoleChange, onRemove, onResend }: MembersCardProps) {
  return (
    // min-w-0: the 680px table scrolls inside the card instead of widening the page.
    <section aria-labelledby="team-members-heading" className="min-w-0 rounded-16 border border-line-alt bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line-subtle px-[18px] py-3.5">
        <h2 id="team-members-heading" className="m-0 text-[15px] font-extrabold">
          <span id={MEMBERS_FOCUS_ID} tabIndex={-1} className="outline-none">
            {TEAM_COPY.membersHeading}
          </span>{" "}
          <span className="font-bold text-ink-2">{"· "}{membersSummary(team.counts)}</span>
        </h2>
        <span className="text-[12.5px] font-semibold text-ink-2">{TEAM_COPY.membersNote}</span>
      </div>
      <div className="hidden overflow-x-auto rounded-b-[15px] cards:block">
        <table className="w-full min-w-[680px] border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-bg text-left text-[11.5px] uppercase tracking-[0.06em] text-ink-2">
              <th scope="col" className={cn(TH, "px-[18px]")}>
                {MEMBER_COLUMNS.member}
              </th>
              <th scope="col" className={cn(TH, "px-3")}>
                {MEMBER_COLUMNS.role}
              </th>
              <th scope="col" className={cn(TH, "px-3")}>
                {MEMBER_COLUMNS.status}
              </th>
              <th scope="col" className={cn(TH, "whitespace-nowrap px-3")}>
                {MEMBER_COLUMNS.lastActive}
              </th>
              <th scope="col" className={cn(TH, "px-[18px]")}>
                <span className="sr-only">{MEMBER_COLUMNS.actions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {team.members.map((member) => (
              <tr key={member.id} className="border-t border-line-subtle">
                <th scope="row" className="px-[18px] py-3 text-left font-normal">
                  <span className="flex items-center gap-2.5">
                    <Avatar member={member} />
                    <span className="min-w-0">
                      <span className="block font-extrabold">{memberTitle(member)}</span>
                      {/* No mid-word breaks here: below ~1000px the 680px table scrolls sideways, as in the prototype. */}
                      <span className="block text-[12px] font-semibold text-ink-2">{member.email}</span>
                    </span>
                  </span>
                </th>
                <td className="p-3">
                  <RoleSelect member={member} onRoleChange={onRoleChange} />
                </td>
                <td className="p-3">
                  <StatusBadge member={member} now={now} />
                </td>
                <td className="whitespace-nowrap p-3 font-semibold">{lastActiveLabel(member, now)}</td>
                <td className="whitespace-nowrap px-[18px] py-3 text-right">
                  {/* One line: the table scrolls sideways rather than stacking Resend over Revoke. */}
                  <RowActions member={member} resending={resending} onRemove={onRemove} onResend={onResend} className="flex-nowrap" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul aria-label={TEAM_COPY.membersHeading} className="m-0 list-none divide-y divide-line-subtle p-0 cards:hidden">
        {team.members.map((member) => (
          <li key={member.id} className="grid gap-3 px-4 py-3.5">
            <div className="flex items-start gap-2.5">
              <Avatar member={member} />
              <div className="min-w-0 flex-1">
                <p className="m-0 font-extrabold">{memberTitle(member)}</p>
                <p className="m-0 mt-0.5 text-[12px] font-semibold text-ink-2 [overflow-wrap:anywhere]">{member.email}</p>
              </div>
            </div>
            <RoleSelect member={member} onRoleChange={onRoleChange} className="w-full" />
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
              <StatusBadge member={member} now={now} />
              <span className="text-[12.5px] font-semibold text-ink-2">
                {MEMBER_COLUMNS.lastActive} {lastActiveLabel(member, now)}
              </span>
              {member.canRemove ? (
                <span className="ml-auto">
                  <RowActions member={member} resending={resending} onRemove={onRemove} onResend={onResend} />
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
