/**
 * Server side of the customer portal shell (decisions.md Phase 5 "Access"). One call per request (React cache):
 *
 * - signed out (or an expired session behind a stale cookie) -> /sign-in?next=<path>
 * - staff -> /admin; unverified customers -> /verify?next=<path>
 * - verified customer without an active membership -> state "no_account" (the layout explains it)
 * - otherwise the active business account (session.activeAccountId, never the client), the user's other accounts,
 *   the team role, locations with active device counts and the shell's badge counts.
 *
 * The layout renders the shell from it; pages call getPortalContext() for the same (cached) value. Layouts do not
 * re-render on client navigation, so pages and API routes must still authorize their own data.
 */
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import {
  LicenseStatus,
  MemberStatus,
  TicketStatus,
  type Prisma,
  type TeamRole,
} from "@/generated/prisma/client";
import type { PortalCounts } from "@/components/account/portal-nav";
import {
  getCurrentAuth,
  NO_ACCOUNT_MESSAGE,
  requireAccountRole,
  type AccountContext,
  type CurrentAuth,
} from "@/lib/auth/guards";
import { safeNext, signInPath, STAFF_HOME, verifyPath } from "@/lib/auth/redirect";
import { DAY_MS } from "@/lib/dates";
import { db, type Db } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { EXPIRING_DAYS } from "@/lib/licensing/status";
import { teamCan, type TeamPermission } from "@/lib/rbac";

/** Request header set by middleware.ts with the requested path + query (layouts cannot read the URL otherwise). */
export const PORTAL_PATH_HEADER = "x-axs-path";
export const PORTAL_HOME = "/account";
/** Locations listed in the business switcher (Devices has the full list). */
export const SWITCHER_LOCATION_LIMIT = 200;

export type PortalUser = { id: string; name: string; email: string };
export type PortalAccount = { id: string; legalName: string };
export type PortalLocation = { id: string; name: string; activeDevices: number };

/** Serializable shell data, handed to the client PortalProvider as is. */
export type PortalContextData = {
  user: PortalUser;
  account: PortalAccount;
  /** Every business the user is an active member of (the switcher lists them when there are several). */
  accounts: PortalAccount[];
  role: TeamRole;
  locations: PortalLocation[];
  counts: PortalCounts;
};

export type PortalContext = PortalContextData & {
  can: (perm: TeamPermission) => boolean;
  /** Session, user, account and membership as the API guards return them. */
  auth: AccountContext;
};

export type PortalState =
  | { kind: "ready"; context: PortalContext }
  | { kind: "no_account"; user: PortalUser };

function isPortalPath(path: string): boolean {
  return path === PORTAL_HOME || path.startsWith(`${PORTAL_HOME}/`) || path.startsWith(`${PORTAL_HOME}?`);
}

/** The requested portal path from the middleware header, validated; /account when missing or unusable. */
export function portalPathFrom(raw: string | null | undefined): string {
  const safe = safeNext(raw);
  return safe && isPortalPath(safe) ? safe : PORTAL_HOME;
}

/** Where a visitor of `path` must go instead of the portal, or null when they may stay. */
export function portalRedirect(auth: CurrentAuth | null, path: string): string | null {
  if (!auth) return signInPath(path);
  if (auth.user.kind === "STAFF") return STAFF_HOME;
  if (!auth.user.emailVerifiedAt) return verifyPath(path);
  return null;
}

/**
 * Licenses that badge the Licenses nav item: derived status "expiring" or "expired" (lib/licensing/status.ts), i.e.
 * ACTIVE ending within EXPIRING_DAYS (or already ended) and TRIAL already ended. Revoked and suspended never count.
 */
export function licensesNeedingAttentionWhere(accountId: string, now: Date): Prisma.LicenseWhereInput {
  return {
    accountId,
    OR: [
      { status: LicenseStatus.ACTIVE, expiresAt: { not: null, lt: new Date(now.getTime() + EXPIRING_DAYS * DAY_MS) } },
      { status: LicenseStatus.TRIAL, expiresAt: { lte: now } },
    ],
  };
}

/** Accounts, locations and badge counts for the active account (all in parallel). */
export async function loadPortalData(client: Db, ctx: AccountContext, now: Date = new Date()): Promise<PortalContextData> {
  const accountId = ctx.account.id;
  const userId = ctx.user.id;
  const role = ctx.membership.role;
  const [memberships, locations, perLocation, tickets, notifications, attention] = await Promise.all([
    client.accountMember.findMany({
      where: { userId, status: MemberStatus.ACTIVE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { account: { select: { id: true, legalName: true } } },
    }),
    client.location.findMany({
      where: { accountId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: SWITCHER_LOCATION_LIMIT,
      select: { id: true, name: true },
    }),
    client.deviceActivation.groupBy({
      by: ["locationId"],
      where: { deactivatedAt: null, location: { accountId }, license: { accountId } },
      _count: { _all: true },
    }),
    teamCan(role, "tickets.view")
      ? client.supportTicket.count({
          where: { accountId, status: { in: [TicketStatus.OPEN, TicketStatus.AWAITING_CUSTOMER] } },
        })
      : Promise.resolve(0),
    client.notification.count({ where: { userId, readAt: null } }),
    teamCan(role, "licenses.view")
      ? client.license.count({ where: licensesNeedingAttentionWhere(accountId, now) })
      : Promise.resolve(0),
  ]);
  const devicesAt = new Map(perLocation.map((row) => [row.locationId, row._count._all]));
  const accounts: PortalAccount[] = [];
  for (const { account } of memberships) {
    if (!accounts.some((a) => a.id === account.id)) accounts.push({ id: account.id, legalName: account.legalName });
  }
  if (!accounts.some((a) => a.id === accountId)) accounts.unshift({ id: accountId, legalName: ctx.account.legalName });
  return {
    user: { id: userId, name: ctx.user.name, email: ctx.user.email },
    account: { id: accountId, legalName: ctx.account.legalName },
    accounts,
    role,
    locations: locations.map((l) => ({ id: l.id, name: l.name, activeDevices: devicesAt.get(l.id) ?? 0 })),
    counts: { tickets, notifications, licensesNeedingAttention: attention },
  };
}

/** The requested portal path (from middleware), for redirect targets. */
async function requestedPath(): Promise<string> {
  return portalPathFrom((await headers()).get(PORTAL_PATH_HEADER));
}

/**
 * Shell state for this request (cached): redirects signed-out, staff and unverified visitors, reports a customer
 * without an active membership as "no_account", else loads the portal context.
 */
export const getPortalState = cache(async (): Promise<PortalState> => {
  const auth = await getCurrentAuth();
  if (!auth || auth.user.kind === "STAFF" || !auth.user.emailVerifiedAt) {
    redirect(portalRedirect(auth, await requestedPath()) ?? PORTAL_HOME);
  }
  let ctx: AccountContext;
  try {
    ctx = await requireAccountRole(undefined, { verified: true });
  } catch (error) {
    if (error instanceof ApiError && error.code === "no_account") {
      return { kind: "no_account", user: { id: auth.user.id, name: auth.user.name, email: auth.user.email } };
    }
    throw error;
  }
  const data = await loadPortalData(db, ctx);
  const role = data.role;
  return { kind: "ready", context: { ...data, auth: ctx, can: (perm: TeamPermission) => teamCan(role, perm) } };
});

/**
 * The portal context for a page or server component (same cached value as the layout). Redirects like the layout;
 * throws 403 `no_account` when the user has no active membership (the layout renders that state instead of pages).
 */
export async function getPortalContext(): Promise<PortalContext> {
  const state = await getPortalState();
  if (state.kind !== "ready") throw errors.forbidden(NO_ACCOUNT_MESSAGE, "no_account");
  return state.context;
}

/** The serializable part of a context (what the layout passes to the client provider). */
export function toPortalContextData(context: PortalContext): PortalContextData {
  const { user, account, accounts, role, locations, counts } = context;
  return { user, account, accounts, role, locations, counts };
}
