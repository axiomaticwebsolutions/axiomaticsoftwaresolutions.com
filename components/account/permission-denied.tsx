import Link from "next/link";
import type { TeamRole } from "@/generated/prisma/enums";
import { Icon } from "@/components/icons/icon";
import { PORTAL_PATHS, teamAreaDeniedMessage } from "@/components/account/portal-nav";
import type { TeamPermission } from "@/lib/rbac";
import { cn } from "@/lib/utils";

export type PermissionDeniedProps = {
  /** What the page is called, for "You don’t have access to {area}". */
  area: string;
  /** The permission the page needs and the member's role (they name the roles that may open it). */
  perm: TeamPermission;
  role: TeamRole;
  /** Message instead of the generated one. */
  message?: string;
  className?: string;
};

/**
 * Permission-denied panel for a portal page the team role cannot open (decisions.md Phase 5; the admin console's
 * denied state with team roles): lock tile, "You don’t have access to {area}", which roles may open it, and a link
 * back to the overview. Server-safe.
 */
export function PermissionDenied({ area, perm, role, message, className }: PermissionDeniedProps) {
  return (
    <div role="alert" className={cn("rounded-16 border border-line-alt bg-surface px-6 py-12 text-center", className)}>
      <span aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-16 bg-pink-bg text-pink-fg">
        <Icon name="lock" size={28} />
      </span>
      <h2 className="mb-0 mt-3.5 text-[19px] font-extrabold leading-[1.3]">You don’t have access to {area}</h2>
      <p className="mx-auto mb-0 mt-1.5 max-w-[440px] text-[14px] leading-[1.6] text-ink-2">
        {message ?? teamAreaDeniedMessage(perm, role)}
      </p>
      <Link
        href={PORTAL_PATHS.overview}
        className="mt-3.5 inline-block rounded-6 text-[14px] font-bold text-primary-link hover:text-primary-link-hover"
      >
        Back to overview
      </Link>
    </div>
  );
}
