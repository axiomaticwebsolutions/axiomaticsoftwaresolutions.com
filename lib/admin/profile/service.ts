/**
 * Server side of Admin > My profile (lib/admin/profile/model.ts): the signed-in staff member's details and live
 * sessions, read from the request's own session. Server-only.
 */
import "server-only";
import { getAdminState } from "@/lib/admin/context";
import { listMySessions, type SessionView } from "@/lib/auth/flows/me";
import type { StaffAuth } from "@/lib/auth/guards";
import type { StaffProfile } from "./model";

export type StaffProfileData = {
  profile: StaffProfile;
  /** GET /api/me/sessions body (this device first). */
  sessions: SessionView[];
  /** Server time (ms) for the first render's relative times. */
  now: number;
};

/** The profile of an active staff member (the caller has checked live staff access). */
export async function loadStaffProfile(auth: StaffAuth, now: Date = new Date()): Promise<StaffProfileData> {
  const { user } = auth;
  const sessions = await listMySessions(auth, now);
  return {
    profile: {
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      role: user.staffRole,
      twoStepEnabled: user.twoStepEnabled,
    },
    sessions,
    now: now.getTime(),
  };
}

/**
 * What app/admin/profile/page.tsx renders, checked on the server like every admin page (lib/admin/context.ts):
 * signed-out visitors (or an expired session) are redirected to /sign-in?next=/admin/profile and customers to
 * /account (redirect() throws); staff without live access (invited, no role) get null, because the admin layout shows
 * its "access isn't active" notice instead of pages; every ACTIVE staff role gets its own profile.
 */
export async function loadAdminProfilePage(now: Date = new Date()): Promise<StaffProfileData | null> {
  const state = await getAdminState();
  if (state.kind !== "ready") return null;
  return loadStaffProfile(state.context.auth, now);
}
