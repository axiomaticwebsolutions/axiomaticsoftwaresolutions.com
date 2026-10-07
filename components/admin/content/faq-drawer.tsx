"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useCan } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { formErrorsFrom, NO_ERRORS, type FormErrors } from "@/components/admin/coupons/form-errors";
import { DestructiveAction } from "@/components/admin/destructive-action";
import { AdminDrawer } from "@/components/admin/drawer";
import { SectionBody } from "@/components/admin/section";
import { StatusBadge } from "@/components/admin/status-badge";
import { toast } from "@/components/ui/sonner";
import { FAQ_COPY, type FaqDto, type FaqPageOption } from "@/lib/admin/content/model";
import { apiFetch } from "@/lib/client/api";
import { FaqForm, type FaqDraft } from "./faq-form";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  faq: FaqDto | null;
  pages: readonly FaqPageOption[];
  onChanged: () => void;
  onDeleted: () => void;
};

const draftOf = (f: FaqDto | null): FaqDraft => ({ page: f?.page ?? "home", question: f?.question ?? "", answer: f?.answer ?? "", href: f?.href ?? "" });

/** FAQ drawer (prototype FAQ): Page / Status facts, "Edit FAQ", its place on the page, Publish or Unpublish and Delete. */
export function FaqDrawer({ open, onOpenChange, faq, pages, onChanged, onDeleted }: Props) {
  const canManage = useCan("content.manage");
  const [draft, setDraft] = React.useState<FaqDraft>(() => draftOf(faq));
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = React.useState<"save" | "publish" | "up" | "down" | null>(null);
  const stored = faq ? `${faq.id}:${faq.page}:${faq.question}:${faq.answer}:${faq.href ?? ""}` : "none";
  const [formFor, setFormFor] = React.useState(stored);
  if (formFor !== stored) {
    setFormFor(stored);
    setDraft(draftOf(faq));
    setErrors(NO_ERRORS);
  }

  async function patch(body: Record<string, unknown>, kind: "save" | "publish", success: string) {
    if (!faq) return;
    setBusy(kind);
    try {
      const res = await apiFetch<{ changed: boolean }>(`/api/admin/faqs/${encodeURIComponent(faq.id)}`, { method: "PATCH", body });
      setErrors(NO_ERRORS);
      toast.success(res.changed ? success : FAQ_COPY.noChanges);
      if (res.changed) onChanged();
    } catch (error) {
      if (kind === "save") setErrors(formErrorsFrom(error));
      else adminToast.error(error);
    } finally {
      setBusy(null);
    }
  }

  function save() {
    if (!faq) return;
    const body: Record<string, unknown> = {};
    if (draft.page !== faq.page) body.page = draft.page;
    if (draft.question.trim() !== faq.question) body.question = draft.question;
    if (draft.answer.trim() !== faq.answer) body.answer = draft.answer;
    if (draft.href.trim() !== (faq.href ?? "")) body.href = draft.href.trim() === "" ? null : draft.href;
    if (Object.keys(body).length === 0) {
      setErrors(NO_ERRORS);
      toast.success(FAQ_COPY.noChanges);
      return;
    }
    void patch(body, "save", FAQ_COPY.saved);
  }

  async function move(direction: "up" | "down") {
    if (!faq) return;
    setBusy(direction);
    try {
      await apiFetch(`/api/admin/faqs/${encodeURIComponent(faq.id)}/move`, { method: "POST", body: { direction } });
      toast.success(FAQ_COPY.moved);
      onChanged();
    } catch (error) {
      adminToast.error(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind="FAQ"
      title={faq?.question ?? "FAQ"}
      status={faq ? <StatusBadge kind="faq" status={faq.status} /> : undefined}
      subtitle={faq ? `${faq.pageLabel} page` : undefined}
      error={open && !faq ? "This FAQ doesn\u2019t exist. It may have been deleted." : undefined}
      fields={
        faq
          ? [
              { label: "Page", value: faq.pageLabel },
              { label: "Status", value: faq.published ? "Published" : "Draft" },
              { label: "Position", value: `${faq.position} of ${faq.pageCount}` },
              { label: "Guide link", value: faq.href, mono: true },
            ]
          : undefined
      }
      edit={
        faq
          ? {
              title: "Edit FAQ",
              readOnly: !canManage,
              form: (
                <FaqForm
                  draft={draft}
                  onChange={setDraft}
                  pages={pages}
                  errors={errors.fields}
                  formError={errors.form}
                  busy={busy === "save"}
                  onSubmit={save}
                  submitLabel="Save changes"
                  idPrefix={`faq-${faq.id}`}
                />
              ),
            }
          : undefined
      }
      sections={
        faq
          ? [
              {
                id: "order",
                title: "Order on the page",
                content: (
                  <SectionBody className="flex flex-wrap items-center gap-2">
                    <p className="m-0 mr-auto text-[13px] font-semibold text-ink-2">
                      {faq.position} of {faq.pageCount} on the {faq.pageLabel} page
                    </p>
                    <AdminAction perm="content.manage" size="xs" icon="arrow_upward" busy={busy === "up"} disabledReason={faq.position <= 1 ? "Already first" : undefined} onClick={() => move("up")}>
                      Move up
                    </AdminAction>
                    <AdminAction perm="content.manage" size="xs" icon="arrow_downward" busy={busy === "down"} disabledReason={faq.position >= faq.pageCount ? "Already last" : undefined} onClick={() => move("down")}>
                      Move down
                    </AdminAction>
                  </SectionBody>
                ),
              },
            ]
          : undefined
      }
      footer={
        faq ? (
          <>
            <AdminAction
              perm="content.manage"
              size="sm"
              icon="publish"
              variant={faq.published ? "default" : "primary"}
              busy={busy === "publish"}
              onClick={() => void patch({ published: !faq.published }, "publish", FAQ_COPY.updated)}
            >
              {faq.published ? "Unpublish" : "Publish"}
            </AdminAction>
            <DestructiveAction
              actionKey="faqs.delete"
              targetId={faq.id}
              consequence={
                <>
                  <span className="block font-semibold text-ink">{faq.question}</span>
                  <span className="mt-1 block">{FAQ_COPY.deleteConsequence}</span>
                </>
              }
              successMessage={FAQ_COPY.deleted}
              onConfirm={async ({ reason }) => {
                await apiFetch(`/api/admin/faqs/${encodeURIComponent(faq.id)}`, { method: "DELETE", body: { reason } });
                onDeleted();
              }}
            />
          </>
        ) : undefined
      }
    />
  );
}
