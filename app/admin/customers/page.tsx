/**
 * /admin/customers (Admin Console.dc.html #customers; customers.view): business accounts with their owner, active
 * licenses, paid orders and lifetime value for the URL state (?q=&filter[gst|state]=&sort=-ltv&page=), and the
 * customer drawer (?id=) with the edit card (customers.edit), Resend verification / Send password reset / Create
 * set-password link (customers.manage) and Mark email as verified (customers.verify_email), and the "New customer"
 * drawer (?new=1; customers.create).
 */
import { Suspense } from "react";
import { unstable_rethrow } from "next/navigation";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { CustomersView } from "@/components/admin/customers/customers-view";
import { NewCustomerAction } from "@/components/admin/customers/new-customer";
import { AdminModulePage } from "@/components/admin/module-page";
import { getAdminState } from "@/lib/admin/context";
import { CUSTOMER_DEFAULT_SORT, CUSTOMERS_LIST } from "@/lib/admin/customers/model";
import { customerStateOptions, listAdminCustomers, type AdminCustomerList } from "@/lib/admin/customers/queries";
import { listQueryFromSearchParams } from "@/lib/admin/licenses/list-state";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

export const metadata = adminPageMetadata("customers");

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AdminCustomersPage({ searchParams }: PageProps) {
  const state = await getAdminState();
  if (state.kind !== "ready") return null;
  // A role without customers.view gets the permission-denied page and nothing is loaded.
  if (!state.context.canView("customers")) return <AdminModulePage moduleKey="customers" />;
  const query = listQueryFromSearchParams(await searchParams, CUSTOMERS_LIST, CUSTOMER_DEFAULT_SORT);
  let data: AdminCustomerList | null = null;
  let states: string[] = [];
  try {
    [data, states] = await Promise.all([listAdminCustomers(db, query, new Date()), customerStateOptions(db)]);
  } catch (error) {
    unstable_rethrow(error);
    log.warn("admin_customers_unavailable", { error: error instanceof Error ? error.message : String(error) });
  }
  return (
    <AdminModulePage
      moduleKey="customers"
      actions={
        <Suspense fallback={null}>
          <NewCustomerAction />
        </Suspense>
      }
    >
      <Suspense>
        <CustomersView data={data} states={states} />
      </Suspense>
    </AdminModulePage>
  );
}
