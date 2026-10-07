import { Suspense } from "react";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { PageSkeletonTable } from "@/components/admin/coupons/table-skeleton";
import { AdminModulePage } from "@/components/admin/module-page";
import { TemplatesView } from "@/components/admin/templates/templates-view";
import { loadTemplates } from "@/lib/admin/templates/service";
import { getSetting } from "@/lib/config";
import { db } from "@/lib/db";
import { footerFromBusiness } from "@/lib/email/compose";
import { getEnv } from "@/lib/env";

export const metadata = adminPageMetadata("templates");

/** Rendered only for roles with templates.manage (AdminModulePage shows the locked page otherwise). */
async function TemplatesSection() {
  const [templates, business] = await Promise.all([loadTemplates(db), getSetting(db, "business")]);
  // The preview footer uses the public business details only (what every email shows), never secrets.
  const preview = { footer: footerFromBusiness(business), appUrl: getEnv().APP_URL };
  return (
    <Suspense fallback={<PageSkeletonTable />}>
      <TemplatesView templates={templates} preview={preview} now={new Date().toISOString()} />
    </Suspense>
  );
}

/** Admin > Notification templates (Admin Console.dc.html #templates). */
export default function AdminTemplatesPage() {
  return (
    <AdminModulePage moduleKey="templates">
      <TemplatesSection />
    </AdminModulePage>
  );
}
