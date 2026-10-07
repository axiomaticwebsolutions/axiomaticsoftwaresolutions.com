/**
 * Portal administration (Owner-only "Team & access" and "Activity log", plus team invitations; docs/decisions.md
 * Phase 5 "Team" and "Activity log"): request bodies (strict), the activity query string and the shared vocabulary.
 * Copy is the prototype's (Customer Portal.dc.html) where it has one. Client-safe: the portal forms reuse it.
 */
import { z } from "zod";
import type { TeamRole } from "@/generated/prisma/enums";
import { makeEmailSchema } from "@/lib/validation/contact";
import { isLinkLikeName, NAME_LINK_ERROR } from "@/lib/validation/names";
import { PASSWORD_ERROR, passwordSchema } from "@/lib/validation/password";

export const TEAM_BODY_MAX_BYTES = 4 * 1024;
/** Invitations stay valid this long (resend issues a fresh link and voids the old ones). */
export const INVITE_TTL_DAYS = 7;
/** Members plus pending invitations per business account. */
export const TEAM_SIZE_LIMIT = 100;
export const MEMBER_NAME_MAX = 120;
export const INVITE_TOKEN_MAX = 256;

/** Roles an owner can invite with; Owner is granted later, to someone who has joined. Default: Technical contact. */
export const INVITE_ROLES = ["BILLING", "TECHNICAL", "VIEWER"] as const satisfies readonly TeamRole[];
export type InviteRole = (typeof INVITE_ROLES)[number];
export const DEFAULT_INVITE_ROLE: InviteRole = "TECHNICAL";
const ALL_ROLES = ["OWNER", "BILLING", "TECHNICAL", "VIEWER"] as const satisfies readonly TeamRole[];

export const TEAM_ERRORS = {
  email: "Enter a valid email address.",
  role: "Choose a role.",
  duplicate: "This person is already on your team.",
  cannotInvite: "This email address can’t be invited. Use a different one.",
  teamFull: `Your team has reached ${TEAM_SIZE_LIMIT} members and invitations. Remove someone before inviting more.`,
  ownRole: "You can’t change your own role.",
  removeSelf: "You can’t remove yourself.",
  lastOwner: "Your team needs at least one owner. Make someone else an owner first.",
  ownerForInvite: "Choose another role for now. You can make them an owner once they’ve joined.",
  notInvited: "This person has already joined.",
  name: "Enter your name.",
  nameTooLong: `Use ${MEMBER_NAME_MAX} characters or fewer.`,
  nameLink: NAME_LINK_ERROR,
  password: PASSWORD_ERROR,
  token: "This invitation link isn’t valid. Ask the account owner to send a new one.",
} as const;

/** POST /api/account/team { email, role }: the address is trimmed and lower-cased. */
export const inviteMemberSchema = z.strictObject({
  email: makeEmailSchema(TEAM_ERRORS.email),
  role: z.enum(INVITE_ROLES, { message: TEAM_ERRORS.role }).default(DEFAULT_INVITE_ROLE),
});
export type InviteMemberInput = z.output<typeof inviteMemberSchema>;

/** PATCH /api/account/team/:memberId { role }. Owner is allowed (an owner may make a member an owner). */
export const changeRoleSchema = z.strictObject({
  role: z.enum(ALL_ROLES, { message: TEAM_ERRORS.role }),
});
export type ChangeRoleInput = z.output<typeof changeRoleSchema>;

export const inviteTokenSchema = z
  .string({ error: TEAM_ERRORS.token })
  .min(1, { message: TEAM_ERRORS.token })
  .max(INVITE_TOKEN_MAX, { message: TEAM_ERRORS.token });

const memberNameSchema = z
  .string({ error: TEAM_ERRORS.name })
  .trim()
  .min(1, { message: TEAM_ERRORS.name })
  .max(MEMBER_NAME_MAX, { message: TEAM_ERRORS.nameTooLong })
  .refine((value) => !isLinkLikeName(value), { message: TEAM_ERRORS.nameLink });

/**
 * POST /api/invites/accept { token, name?, password? }. Someone who already has an account signs in and sends only
 * the token; a new person also chooses their name and a password (checked by the server, which knows which case
 * applies: missing fields answer 422 on those fields).
 */
export const acceptInviteSchema = z.strictObject({
  token: inviteTokenSchema,
  name: memberNameSchema.optional(),
  password: passwordSchema.optional(),
});
export type AcceptInviteInput = z.output<typeof acceptInviteSchema>;

// ---------- Activity log ----------

export const ACTIVITY_KINDS = ["license", "security", "billing", "team", "ticket", "download"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
/** The "Type" filter, in prototype order. */
export const ACTIVITY_KIND_LABELS: Readonly<Record<ActivityKind | "all", string>> = {
  all: "All activity",
  license: "Licenses & devices",
  security: "Security",
  billing: "Billing",
  team: "Team",
  ticket: "Support",
  download: "Downloads",
};
export const ACTIVITY_PAGE_SIZE = 10;
/** "kept for 24 months": older entries are not listed or exported. */
export const ACTIVITY_RETENTION_MONTHS = 24;
export const ACTIVITY_SEARCH_MAX = 100;

export function isActivityKind(value: string): value is ActivityKind {
  return (ACTIVITY_KINDS as readonly string[]).includes(value);
}

export type ActivityQuery = { kind: ActivityKind | "all"; q: string; page: number };

const activityQuerySchema = z.strictObject({
  kind: z.enum(["all", ...ACTIVITY_KINDS], { message: "Choose a valid activity type." }).default("all"),
  q: z.string().trim().max(ACTIVITY_SEARCH_MAX, { message: `Use ${ACTIVITY_SEARCH_MAX} characters or fewer.` }).default(""),
  page: z.coerce.number({ error: "Choose a valid page." }).int().min(1, { message: "Choose a valid page." }).max(100_000).default(1),
});

/** Parses GET /api/account/activity?kind=&q=&page= (empty values take the default). Throws ZodError (422). */
export function parseActivityQuery(params: URLSearchParams): ActivityQuery {
  const raw: Record<string, string> = {};
  for (const key of ["kind", "q", "page"]) {
    const value = params.get(key);
    if (value !== null && value.trim() !== "") raw[key] = value;
  }
  return activityQuerySchema.parse(raw);
}
