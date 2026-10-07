/** CSV columns of the Licenses export (GET /api/admin/licenses/export.csv). Keys stay masked. Pure. */
import type { CsvColumn } from "@/lib/csv";
import { LICENSE_STATUS_META } from "@/lib/licensing/status";
import { csvDateIST } from "./list-state";
import type { AdminLicenseRow } from "./model";

export const LICENSE_CSV_COLUMNS: readonly CsvColumn<AdminLicenseRow>[] = [
  { header: "License", value: (r) => r.id },
  { header: "Product", value: (r) => r.productName },
  { header: "Plan", value: (r) => r.planName },
  { header: "Customer", value: (r) => r.customerName },
  { header: "Email", value: (r) => r.customerEmail ?? "" },
  { header: "Key", value: (r) => r.keyMasked },
  { header: "Status", value: (r) => LICENSE_STATUS_META[r.status].adminLabel },
  { header: "Expires", value: (r) => (r.expiresAt ? csvDateIST(r.expiresAt) : "No end date") },
  { header: "Devices used", value: (r) => r.devicesUsed },
  { header: "Device limit", value: (r) => r.deviceLimit },
  { header: "Issued", value: (r) => csvDateIST(r.issuedAt) },
];
