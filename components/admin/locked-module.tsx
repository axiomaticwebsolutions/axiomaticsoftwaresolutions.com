import Link from "next/link";
import type { StaffRole } from "@/generated/prisma/enums";
import { Icon } from "@/components/icons/icon";
import { ADMIN_HOME } from "@/components/admin/admin-nav";
import { areaDeniedMessage, type Permission } from "@/lib/rbac";
import { cn } from "@/lib/utils";

export type LockedModuleProps = {
  /** Module title, for "You don’t have access to {title}". */
  title: string;
  /** The permission the module needs and the viewer's role (the message names the roles that may open it). */
  perm: Permission;
  role: StaffRole;
  className?: string;
};

/**
 * Permission-denied page for a module the role cannot open (Admin Console.dc.html `denied`): white card, pink lock
 * tile, "You don’t have access to {title}", which roles may open it and a link back to the overview. Server-safe.
 */
export function LockedModule({ title, perm, role, className }: LockedModuleProps) {
  return (
    <div role="alert" className={cn("rounded-16 border border-line-alt bg-surface px-6 py-12 text-center", className)}>
      <span aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-16 bg-pink-bg text-pink-fg">
        <Icon name="lock" size={28} />
      </span>
      <h2 className="mb-0 mt-3.5 text-[19px] font-extrabold leading-[1.3]">You don’t have access to {title}</h2>
      <p className="mx-auto mb-0 mt-1.5 max-w-[440px] text-[14px] leading-[1.6] text-ink-2">{areaDeniedMessage(perm, role)}</p>
      <Link
        href={ADMIN_HOME}
        className="mt-3.5 inline-block rounded-6 text-[14px] font-bold text-primary-link underline underline-offset-2 hover:text-primary-link-hover"
      >
        Back to overview
      </Link>
    </div>
  );
}
