/** CSV columns of the Renewals export (GET /api/admin/renewals/export.csv). Pure. */
import { csvDateIST } from "@/lib/admin/licenses/list-state";
import type { CsvColumn } from "@/lib/csv";
import { paiseToDecimalString } from "@/lib/money";
import type { AdminRenewalRow } from "./model";

export const RENEWAL_CSV_COLUMNS: readonly CsvColumn<AdminRenewalRow>[] = [
  { header: "License", value: (r) => r.id },
  { header: "Product", value: (r) => r.productName },
  { header: "Plan", value: (r) => r.planName },
  { header: "Customer", value: (r) => r.customerName },
  { header: "Email", value: (r) => r.customerEmail ?? "" },
  { header: "Ends", value: (r) => csvDateIST(r.expiresAt) },
  { header: "Days", value: (r) => r.daysLeft },
  { header: "Renewal value excl. GST (INR)", value: (r) => paiseToDecimalString(r.renewalValuePaise) },
  { header: "Last reminder", value: (r) => csvDateIST(r.lastReminderAt) },
];
