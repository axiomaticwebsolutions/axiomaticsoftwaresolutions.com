/** CSV columns of the Customers export (GET /api/admin/customers/export.csv). Pure. */
import { csvDateIST } from "@/lib/admin/licenses/list-state";
import type { CsvColumn } from "@/lib/csv";
import { paiseToDecimalString } from "@/lib/money";
import { emailBadge, type AdminCustomerRow } from "./model";

export const CUSTOMER_CSV_COLUMNS: readonly CsvColumn<AdminCustomerRow>[] = [
  { header: "Customer", value: (r) => r.ownerName ?? "" },
  { header: "Email", value: (r) => r.ownerEmail ?? "" },
  { header: "Email status", value: (r) => emailBadge(r.ownerVerified).label },
  { header: "Business", value: (r) => r.legalName },
  { header: "GSTIN", value: (r) => r.gstin ?? "" },
  { header: "State", value: (r) => r.state ?? "" },
  { header: "Active licenses", value: (r) => r.activeLicenses },
  { header: "Orders", value: (r) => r.orders },
  { header: "Lifetime value (INR)", value: (r) => paiseToDecimalString(r.lifetimeValuePaise) },
  { header: "Last order", value: (r) => csvDateIST(r.lastOrderAt) },
];
