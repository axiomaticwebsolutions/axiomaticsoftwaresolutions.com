"use client";

import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useCan } from "@/components/admin/admin-context";
import { formErrorsFrom, NO_ERRORS, type FormErrors } from "@/components/admin/coupons/form-errors";
import { AdminDrawer } from "@/components/admin/drawer";
import { withParam } from "@/components/admin/model";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { toast } from "@/components/ui/sonner";
import { FAQ_COPY, type FaqDto, type FaqPageOption } from "@/lib/admin/content/model";
import { apiFetch } from "@/lib/client/api";
import { FaqForm, type FaqDraft } from "./faq-form";

export const NEW_FAQ_PARAM = "new";

/** Header action "New FAQ" (content.manage). */
export function NewFaqAction() {
  const create = useDrawerParam(NEW_FAQ_PARAM);
  return (
    <AdminAction perm="content.manage" variant="primary" icon="add" onClick={() => create.open("1")} aria-haspopup="dialog">
      {FAQ_COPY.newFaq}
    </AdminAction>
  );
}

type Props = { open: boolean; onOpenChange: (open: boolean) => void; pages: readonly FaqPageOption[]; defaultPage: string };

/** "New FAQ" drawer: saved as a draft at the end of its page (prototype "Draft FAQ added"), then shown for review. */
export function NewFaqDrawer({ open, onOpenChange, pages, defaultPage }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const canManage = useCan("content.manage");
  const blank = React.useCallback((): FaqDraft => ({ page: defaultPage, question: "", answer: "", href: "" }), [defaultPage]);
  const [draft, setDraft] = React.useState<FaqDraft>(blank);
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(blank());
      setErrors(NO_ERRORS);
    }
  }

  async function create() {
    setBusy(true);
    try {
      const body = { page: draft.page, question: draft.question, answer: draft.answer, href: draft.href.trim() === "" ? null : draft.href };
      const { faq } = await apiFetch<{ faq: FaqDto }>("/api/admin/faqs", { method: "POST", body });
      toast.success(FAQ_COPY.created);
      const search = withParam(withParam(window.location.search, NEW_FAQ_PARAM, null), "id", faq.id);
      router.replace(`${pathname}${search}`, { scroll: false });
    } catch (error) {
      setErrors(formErrorsFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind="FAQ"
      title={FAQ_COPY.newFaq}
      subtitle="Saved as a draft at the end of its page. Publish it when it’s ready."
      edit={{
        title: "Edit FAQ",
        readOnly: !canManage,
        form: (
          <FaqForm
            draft={draft}
            onChange={setDraft}
            pages={pages}
            errors={errors.fields}
            formError={errors.form}
            busy={busy}
            onSubmit={create}
            submitLabel="Add FAQ"
            idPrefix="faq-new"
          />
        ),
      }}
    />
  );
}
