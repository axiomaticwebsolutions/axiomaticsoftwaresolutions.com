import { Icon } from "@/components/icons/icon";
import { PERMISSION_ROWS, STAFF_COPY } from "@/lib/admin/staff/model";
import { can, STAFF_ROLE_LABELS, STAFF_ROLES } from "@/lib/rbac";

/**
 * "Role permissions" panel under the staff table (prototype extra.roles): every permission in lib/rbac.ts PERMS with
 * its code and label, and a tick or a dash per role (role="img" with "Allowed for Owner" / "Not allowed for Support").
 * The table scrolls sideways inside its card on narrow screens (keyboard-focusable region). Server-safe.
 */
export function RolePermissionsPanel() {
  const headingId = "role-permissions-title";
  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-14 border border-line-alt bg-surface leading-[normal]">
      <div className="border-b border-line-subtle px-4 py-3">
        <h2 id={headingId} className="m-0 text-[14.5px] font-extrabold">
          {STAFF_COPY.permissionsTitle}
        </h2>
        <p className="m-0 mt-0.5 text-[12.5px] text-ink-2">{STAFF_COPY.permissionsDescription}</p>
      </div>
      <div
        role="region"
        aria-labelledby={headingId}
        // A scrollable region must be reachable by keyboard (axe scrollable-region-focusable).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="overflow-x-auto rounded-b-14 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
      >
        <table className="w-full min-w-[620px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-bg text-left text-[11px] tracking-[0.06em] text-ink-2">
              <th scope="col" className="px-4 py-[9px] font-extrabold uppercase">
                {STAFF_COPY.permissionColumn}
              </th>
              {STAFF_ROLES.map((role) => (
                <th key={role} scope="col" className="px-2.5 py-[9px] text-center font-extrabold">
                  {STAFF_ROLE_LABELS[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_ROWS.map((row) => (
              <tr key={row.key} className="border-t border-line-subtle">
                <th scope="row" className="px-4 py-2 text-left font-semibold">
                  <code className="font-mono text-[12px] font-bold text-lavender-fg">{row.key}</code>{" "}
                  <span className="text-ink-2">{row.label}</span>
                </th>
                {STAFF_ROLES.map((role) => {
                  const allowed = can(role, row.key);
                  const label = allowed ? STAFF_COPY.allowedFor(STAFF_ROLE_LABELS[role]) : STAFF_COPY.notAllowedFor(STAFF_ROLE_LABELS[role]);
                  return (
                    <td key={role} className="px-2.5 py-2 text-center">
                      <span role="img" aria-label={label} className="inline-flex align-middle">
                        <Icon name={allowed ? "check_circle" : "remove"} size={18} className={allowed ? "text-success" : "text-muted-icon"} />
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
