import { Icon } from "@/components/icons/icon";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { cn } from "@/lib/utils";
import { MATRIX_COLUMNS, permissionMatrix, TEAM_COPY, type MatrixCell } from "./team-model";

const ROWS = permissionMatrix();

function CellIcon({ cell, size = 19 }: { cell: MatrixCell; size?: number }) {
  return (
    <span role="img" aria-label={cell.label} className={cn("inline-flex", cell.allowed ? "text-success" : "text-muted-icon")}>
      <Icon name={cell.allowed ? "check_circle" : "remove"} size={size} />
    </span>
  );
}

/**
 * "What each role can do" (prototype): PERMISSION x OWNER / BILLING ADMIN / TECHNICAL / VIEWER with check_circle
 * (success) and remove icons labelled "Allowed|Not allowed for {role}", built from TEAM_MATRIX_ROWS. Below 760px
 * each permission becomes a card listing the four roles (README: tables become cards). Server-safe.
 */
export function PermissionMatrix() {
  return (
    <section aria-labelledby="team-matrix-heading" className="rounded-16 border border-line-alt bg-surface">
      <div className="border-b border-line-subtle px-[18px] py-3.5">
        <h2 id="team-matrix-heading" className="m-0 text-[15px] font-extrabold">
          {TEAM_COPY.matrixHeading}
        </h2>
      </div>
      <ScrollRegion labelledBy="team-matrix-heading" className="hidden cards:block">
        <table className="w-full min-w-[620px] border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-bg text-left text-[11.5px] uppercase tracking-[0.06em] text-ink-2">
              <th scope="col" className="px-[18px] py-2.5 font-extrabold">
                {TEAM_COPY.permission}
              </th>
              {MATRIX_COLUMNS.map((column) => (
                <th key={column.role} scope="col" className="px-3 py-2.5 text-center font-extrabold">
                  {column.heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label} className="border-t border-line-subtle">
                <th scope="row" className="px-[18px] py-2.5 text-left font-bold">
                  {row.label}
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.role} className="px-3 py-2.5 text-center align-middle">
                    <CellIcon cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <ul aria-label={TEAM_COPY.matrixHeading} className="m-0 list-none divide-y divide-line-subtle p-0 cards:hidden">
        {ROWS.map((row) => (
          <li key={row.label} className="px-4 py-3">
            <p className="m-0 text-[13.5px] font-bold">{row.label}</p>
            <ul className="m-0 mt-2 grid list-none grid-cols-2 gap-x-3 gap-y-1.5 p-0 text-[13px] font-semibold text-ink-2">
              {row.cells.map((cell) => (
                <li key={cell.role} className="flex min-w-0 items-center gap-1.5">
                  <CellIcon cell={cell} size={17} />
                  <span aria-hidden="true">{MATRIX_COLUMNS.find((c) => c.role === cell.role)?.label}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
