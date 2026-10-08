/**
 * Admin > My profile (/admin/profile; decisions.md 2026-10-08): every active staff member's own page, linked from the
 * top bar's account menu. Their name, email and role (read-only: the Owner changes roles in Staff & roles), the
 * two-step sign-in switch (off by default for every role; codes are emailed, so it is turned on once email sending
 * works), password change and active sessions. It reuses the portal Security cards and the /api/me routes; nothing
 * here is customer-specific. Pure and client-safe; new copy (owner review).
 */
import type { StaffRole } from "@/generated/prisma/enums";

export const ADMIN_PROFILE_PATH = "/admin/profile";

/** The signed-in staff member as the page shows them (never the password hash or tokens). */
export type StaffProfile = {
  name: string;
  email: string;
  emailVerified: boolean;
  role: StaffRole;
  twoStepEnabled: boolean;
};

export const PROFILE_COPY = {
  title: "My profile",
  menuLabel: "My profile",
  description: "Your details, two-step verification, password and the devices signed in as you.",
  detailsTitle: "Your details",
  detailsDescription: "Only an Owner can change your role, in Staff & roles.",
  name: "Name",
  email: "Email",
  role: "Role",
} as const;
