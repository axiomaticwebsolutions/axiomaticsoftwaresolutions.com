/**
 * Server CSV exports for the admin tables of Coupons, Content, Templates and Leads: downloads `<path>?<list filters>`
 * (the server writes the "Exported report" audit row) and toasts "Exported {n} rows · {file}". Browser only.
 */
import { downloadFromApi } from "@/components/account/activity/download-file";
import { adminToast } from "@/components/admin/admin-toaster";
import { exportToast } from "./export-model";

export { exportHref, exportToast } from "./export-model";

export async function exportCsv(href: string, fallbackName: string): Promise<void> {
  try {
    const { fileName, headers } = await downloadFromApi(href, fallbackName);
    const rows = Number(headers.get("x-row-count") ?? "0") || 0;
    adminToast.success(exportToast(rows, fileName, headers.get("x-truncated") === "1"));
  } catch (error) {
    adminToast.error(error, "The export didn’t finish. Try again.");
  }
}
