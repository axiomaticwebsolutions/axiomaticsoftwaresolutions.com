"use client";

import * as React from "react";
import { AdminAction, type AdminActionSize } from "@/components/admin/admin-action";
import { adminToast } from "@/components/admin/admin-toaster";
import type { RangeKey } from "@/lib/admin/overview/range";
import { exportToastText, REPORT_EXPORTS, reportExportPath, type ReportExportKey } from "@/lib/admin/reports/model";
import { exportNeedsLabel } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { downloadReport } from "./download";

export type ReportExportButtonProps = {
  report: ReportExportKey;
  range: RangeKey;
  /** Visible text (default "Export CSV"). */
  label?: string;
  size?: AdminActionSize;
  className?: string;
};

/**
 * Downloads one report as CSV (`reports.export`: Owner and Finance; others see it disabled with "Export needs Owner /
 * Finance"). The server audits every export; the toast reads "Exported {n} rows · {file}" (prototype).
 */
export function ReportExportButton({ report, range, label = "Export CSV", size = "sm", className }: ReportExportButtonProps) {
  const [busy, setBusy] = React.useState(false);
  const title = REPORT_EXPORTS[report].title;
  const run = async () => {
    setBusy(true);
    try {
      const file = await downloadReport(reportExportPath(report, range), `${report}.csv`);
      adminToast.success(exportToastText(file.rows, file.fileName, file.truncated));
    } catch (error) {
      adminToast.error(error, `We couldn\u2019t export the ${title.toLowerCase()}. Please try again.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AdminAction
      perm="reports.export"
      deniedLabel={exportNeedsLabel("reports.export")}
      icon="download"
      size={size}
      busy={busy}
      onClick={run}
      aria-label={`${label}: ${title}`}
      className={cn(className)}
    >
      {label}
    </AdminAction>
  );
}
