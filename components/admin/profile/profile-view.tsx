"use client";

import { PasswordForm } from "@/components/account/security/password-form";
import { ProtectionCard } from "@/components/account/security/protection-card";
import { SECURITY_COPY, type SessionView } from "@/components/account/security/security-model";
import { CardHeading, SECURITY_CARD } from "@/components/account/security/security-parts";
import { SessionsCard } from "@/components/account/security/sessions-card";
import { useSessionList } from "@/components/account/security/use-session-list";
import { FieldGrid } from "@/components/admin/field-grid";
import { StatusBadge } from "@/components/admin/status-badge";
import { Badge } from "@/components/ui/badge";
import { PROFILE_COPY, type StaffProfile } from "@/lib/admin/profile/model";

export type StaffProfileViewProps = {
  profile: StaffProfile;
  /** GET /api/me/sessions body, loaded by the server page (this device first). */
  sessions: SessionView[];
  /** Server time (ms) for the first render's relative times. */
  now: number;
};

/**
 * "Your details": name, role and email, read-only (the Owner changes roles in Staff & roles). Same card shell and
 * heading as the reused Security cards beside it (radius 16, 18px sides, 15px heading), so the grid reads as one set.
 */
function ProfileDetails({ profile }: { profile: StaffProfile }) {
  return (
    <section aria-labelledby="profile-details-heading" className={SECURITY_CARD}>
      <CardHeading id="profile-details-heading">{PROFILE_COPY.detailsTitle}</CardHeading>
      <div className="grid gap-2.5 px-[18px] py-4">
        <p className="m-0 text-[13.5px] leading-[1.5] text-ink-2">{PROFILE_COPY.detailsDescription}</p>
        <FieldGrid
          fields={[
            { label: PROFILE_COPY.name, value: profile.name },
            { label: PROFILE_COPY.role, value: <StatusBadge kind="role" status={profile.role} /> },
            {
              label: PROFILE_COPY.email,
              wide: true,
              value: (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 break-all">{profile.email}</span>
                  {profile.emailVerified ? null : (
                    <Badge tone="peach" className="px-2 py-0.5 text-[11.5px] leading-[normal]">
                      {SECURITY_COPY.notVerified}
                    </Badge>
                  )}
                </span>
              ),
            },
          ]}
        />
      </div>
    </section>
  );
}

/**
 * Admin > My profile (decisions.md 2026-10-08): the staff member's details, the two-step switch (the portal
 * ProtectionCard without "Account data"), "Password" and "Active sessions", all through the same /api/me routes as
 * the portal Security page, in auto-fit columns of 400px (one column on phones).
 */
export function StaffProfileView({ profile, sessions: initialSessions, now: serverNow }: StaffProfileViewProps) {
  const { sessions, now, reload } = useSessionList(initialSessions, serverNow);
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,400px),1fr))] items-start gap-3.5">
      <ProfileDetails profile={profile} />
      <ProtectionCard twoStepEnabled={profile.twoStepEnabled} accountData={false} />
      <PasswordForm email={profile.email} onChanged={() => void reload()} />
      <SessionsCard sessions={sessions} now={now} onChanged={reload} />
    </div>
  );
}
