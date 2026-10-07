import { Suspense } from "react";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { FaqsView } from "@/components/admin/content/faqs-view";
import { NewFaqAction } from "@/components/admin/content/new-faq";
import { NoticePanel } from "@/components/admin/content/notice-panel";
import { PageSkeletonTable } from "@/components/admin/coupons/table-skeleton";
import { AdminModulePage } from "@/components/admin/module-page";
import { getContentNotices, loadFaqs } from "@/lib/admin/content/service";
import { db } from "@/lib/db";

export const metadata = adminPageMetadata("content");

/** Rendered only for roles with content.manage (AdminModulePage shows the locked page otherwise). */
async function ContentSections() {
  const [{ faqs, pages }, notices] = await Promise.all([loadFaqs(db), getContentNotices(db)]);
  return (
    <>
      <Suspense fallback={<PageSkeletonTable />}>
        <FaqsView faqs={faqs} pages={pages} />
      </Suspense>
      <NoticePanel noticeKey="banner" notice={notices.banner} />
      <NoticePanel noticeKey="sample-notice" notice={notices["sample-notice"]} />
    </>
  );
}

/** Admin > Website content & FAQs (Admin Console.dc.html #content). */
export default function AdminContentPage() {
  return (
    <AdminModulePage
      moduleKey="content"
      actions={
        <Suspense fallback={null}>
          <NewFaqAction />
        </Suspense>
      }
    >
      <ContentSections />
    </AdminModulePage>
  );
}
