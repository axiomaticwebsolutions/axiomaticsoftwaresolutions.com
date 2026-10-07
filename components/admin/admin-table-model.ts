/**
 * Pure helpers behind <AdminTable> (no React): the CSV permission label and the prototype's "a filter change clears
 * the selection" rule (Admin Console.dc.html `table()`). Client-safe; unit tested.
 */
import type { DataTableToolbar } from "@/components/data-table/types";
import { can, exportNeedsLabel, NOT_ALLOWED_FOR_ROLE, rolesFor, STAFF_ROLE_LABELS, type Permission } from "@/lib/rbac";

/**
 * What a module's CSV export needs: one permission, or several held together (decisions.md Phase 6: FAQ, template
 * and lead exports need the module permission as well as reports.export, so they are Owner-only).
 */
export type ExportPerm = Permission | readonly Permission[];

export function exportPermList(perm: ExportPerm): readonly Permission[] {
  return typeof perm === "string" ? [perm] : perm;
}

/** Whether a role-aware `can` allows the export (every permission it needs). */
export function canExport(perm: ExportPerm, allows: (perm: Permission) => boolean): boolean {
  return exportPermList(perm).every((p) => allows(p));
}

/**
 * Tooltip on a disabled CSV button, naming only the roles that hold every permission the export needs:
 * "Export needs Owner / Finance" (reports.export), "Export needs Owner" (reports.export + content.manage).
 */
export function exportNeedsAllLabel(perm: ExportPerm): string {
  const perms = exportPermList(perm);
  const [first, ...rest] = perms;
  if (!first) return NOT_ALLOWED_FOR_ROLE;
  if (rest.length === 0) return exportNeedsLabel(first);
  const roles = rolesFor(first).filter((role) => rest.every((p) => can(role, p)));
  return roles.length > 0 ? `Export needs ${roles.map((role) => STAFF_ROLE_LABELS[role]).join(" / ")}` : NOT_ALLOWED_FOR_ROLE;
}

/**
 * The toolbar with every filter change, and Clear, also clearing the selection (prototype: a filter change resets to
 * page 1 and clears `sel`), so a bulk action never runs on rows the new filter hides. Search and paging keep the
 * selection, as in the prototype.
 */
export function withSelectionReset<T>(toolbar: DataTableToolbar<T>, clearSelection: () => void): DataTableToolbar<T> {
  const { filters, onClear } = toolbar;
  return {
    ...toolbar,
    ...(filters
      ? {
          filters: filters.map((filter) => ({
            ...filter,
            onChange: (value: string) => {
              clearSelection();
              filter.onChange(value);
            },
          })),
        }
      : {}),
    ...(onClear
      ? {
          onClear: () => {
            clearSelection();
            onClear();
          },
        }
      : {}),
  };
}
