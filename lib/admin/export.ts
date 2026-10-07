/**
 * Admin CSV exports (decisions.md Phase 6): `GET /api/admin/<resource>/export.csv` with the list's filters. Exports need
 * `reports.export` (Owner, Finance); the audit log export needs `audit.view`. Every export writes one audit row
 * "Exported report" before the file is returned, and adminRoute() already refuses cross-site requests.
 *
 * Files follow lib/csv.ts (BOM, CRLF, every cell quoted, formula guard). Query at most `maxRows + 1` rows: the extra row
 * tells csvExportResponse() the file was cut (`X-Truncated: 1`); `X-Row-Count` carries the rows written (for the
 * "Exported N rows to <file>" toast). Exports are rate limited per staff member (RATE_LIMITS.adminExport, 429).
 */
import "server-only";
import type { StaffRole } from "@/generated/prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { csvFileName, csvHeaders, toCsv, type CsvColumn } from "@/lib/csv";
import { db, type Db } from "@/lib/db";
import { errors } from "@/lib/http";
import { can, exportNeedsLabel, type Permission } from "@/lib/rbac";

export const ADMIN_EXPORT_MAX_ROWS = 10_000;

export type ExportPermission = Extract<Permission, "reports.export" | "audit.view">;

export type CsvExportOptions<T> = {
  staff: { id: string; role: StaffRole };
  actor: AuditActor;
  perm: ExportPermission;
  /** Download name, e.g. "orders-2026-10-07.csv" (sanitised, ".csv" added). */
  fileName: string;
  /** At most maxRows + 1 rows (the extra row only marks truncation). */
  rows: readonly T[];
  columns: readonly CsvColumn<T>[];
  /** Audit target: the report's name ("Orders", "GST summary · Sep 2026", "Audit log"). */
  auditTarget: string;
  /** Extra audit detail, e.g. the filters ("status: paid · last 30 days"). Never secrets. */
  auditDetail?: string | null;
  /** Default ADMIN_EXPORT_MAX_ROWS. */
  maxRows?: number;
  /** Database client (tests). */
  client?: Db;
};

/** Builds the CSV, writes the "Exported report" audit row and returns the download response. */
export async function csvExportResponse<T>(opts: CsvExportOptions<T>): Promise<Response> {
  if (!can(opts.staff.role, opts.perm)) throw errors.forbidden(exportNeedsLabel(opts.perm));
  enforce(await hit(opts.client ?? db, RATE_LIMITS.adminExport(opts.staff.id)));
  const maxRows = Math.max(1, opts.maxRows ?? ADMIN_EXPORT_MAX_ROWS);
  const truncated = opts.rows.length > maxRows;
  const rows = truncated ? opts.rows.slice(0, maxRows) : opts.rows;
  const csv = toCsv(rows, opts.columns);
  const fileName = csvFileName(opts.fileName);

  const detail = [`CSV · ${rows.length} ${rows.length === 1 ? "row" : "rows"}${truncated ? " (truncated)" : ""}`, opts.auditDetail]
    .filter(Boolean)
    .join(" · ");
  await audit(opts.client ?? db, opts.actor, {
    action: "Exported report",
    target: opts.auditTarget,
    targetType: "report",
    targetId: fileName,
    detail,
  });

  return new Response(csv, {
    status: 200,
    headers: {
      ...csvHeaders(fileName),
      "X-Row-Count": String(rows.length),
      ...(truncated ? { "X-Truncated": "1" } : {}),
    },
  });
}
