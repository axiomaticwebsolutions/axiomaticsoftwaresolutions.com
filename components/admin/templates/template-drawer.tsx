"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useCan } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { formErrorsFrom, NO_ERRORS, type FormErrors } from "@/components/admin/coupons/form-errors";
import { AdminDrawer } from "@/components/admin/drawer";
import { StatusBadge } from "@/components/admin/status-badge";
import { toast } from "@/components/ui/sonner";
import { TEMPLATE_COPY, TEMPLATE_STATUS_LABELS, type TemplateDto, type TemplatePreviewContext } from "@/lib/admin/templates/model";
import { apiFetch } from "@/lib/client/api";
import { TemplateEditor, type TemplateDraft } from "./template-editor";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: TemplateDto | null;
  preview: TemplatePreviewContext;
  onChanged: () => void;
};

function statusNote(t: TemplateDto): string | null {
  if (t.status === "draft") return TEMPLATE_COPY.draftNote;
  if (t.status === "default") return TEMPLATE_COPY.builtInNote;
  return null;
}

/**
 * Template drawer (prototype EMAIL TEMPLATE): Channel / Trigger / Variables, the "Content" editor with the live
 * preview (read only without templates.manage), "Send test to me" and "Set to draft" / "Activate".
 */
export function TemplateDrawer({ open, onOpenChange, template, preview, onChanged }: Props) {
  const canManage = useCan("templates.manage");
  const [draft, setDraft] = React.useState<TemplateDraft>({ subject: template?.subject ?? "", body: template?.body ?? "" });
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = React.useState<"save" | "test" | "status" | null>(null);
  const stored = template ? `${template.id}:${template.updatedAt ?? ""}:${template.subject}:${template.body}` : "none";
  const [formFor, setFormFor] = React.useState(stored);
  if (formFor !== stored) {
    setFormFor(stored);
    setDraft({ subject: template?.subject ?? "", body: template?.body ?? "" });
    setErrors(NO_ERRORS);
  }

  async function save() {
    if (!template) return;
    const body: Record<string, unknown> = {};
    if (draft.subject.trim() !== template.subject) body.subject = draft.subject;
    if (draft.body.trim() !== template.body) body.body = draft.body;
    if (Object.keys(body).length === 0) {
      setErrors(NO_ERRORS);
      toast.success(TEMPLATE_COPY.noChanges);
      return;
    }
    setBusy("save");
    try {
      await apiFetch(`/api/admin/templates/${encodeURIComponent(template.id)}`, { method: "PATCH", body });
      setErrors(NO_ERRORS);
      toast.success(TEMPLATE_COPY.saved);
      onChanged();
    } catch (error) {
      setErrors(formErrorsFrom(error));
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    if (!template) return;
    setBusy("test");
    try {
      const unsaved = draft.subject.trim() !== template.subject || draft.body.trim() !== template.body;
      const { sentTo } = await apiFetch<{ sentTo: string }>(`/api/admin/templates/${encodeURIComponent(template.id)}/test`, {
        method: "POST",
        body: unsaved ? { subject: draft.subject, body: draft.body } : {},
      });
      toast.success(TEMPLATE_COPY.testSent(sentTo));
    } catch (error) {
      const errs = formErrorsFrom(error);
      if (Object.keys(errs.fields).length > 0) setErrors(errs);
      adminToast.error(error);
    } finally {
      setBusy(null);
    }
  }

  async function setActive(active: boolean) {
    if (!template) return;
    setBusy("status");
    try {
      await apiFetch(`/api/admin/templates/${encodeURIComponent(template.id)}`, { method: "PATCH", body: { active } });
      toast.success(TEMPLATE_COPY.statusUpdated);
      onChanged();
    } catch (error) {
      adminToast.error(error);
    } finally {
      setBusy(null);
    }
  }

  const note = template ? statusNote(template) : null;
  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind="Email template"
      title={template?.name ?? "Template"}
      status={template ? <StatusBadge kind="template" status={template.status} label={TEMPLATE_STATUS_LABELS[template.status]} /> : undefined}
      subtitle={template ? <span className="font-mono">{template.id}</span> : undefined}
      error={open && !template ? "This template doesn\u2019t exist." : undefined}
      fields={
        template
          ? [
              { label: "Channel", value: template.channel },
              { label: "Trigger", value: template.trigger },
              { label: "Variables", value: template.vars.join(", ") || "None", wide: true },
              ...(template.auth ? [{ label: "Delivery", value: TEMPLATE_COPY.authNote, wide: true }] : []),
              ...(template.attachmentNote ? [{ label: "Attachment", value: template.attachmentNote, wide: true }] : []),
            ]
          : undefined
      }
      edit={
        template
          ? {
              title: "Content",
              readOnly: !canManage,
              form: (
                <>
                  {note ? <p className="m-0 rounded-8 bg-peach-soft px-2.5 py-2 text-[12.5px] font-semibold text-peach-fg">{note}</p> : null}
                  <TemplateEditor
                    template={template}
                    draft={draft}
                    onChange={setDraft}
                    errors={errors.fields}
                    formError={errors.form}
                    busy={busy === "save"}
                    onSubmit={save}
                    preview={preview}
                  />
                </>
              ),
            }
          : undefined
      }
      footer={
        template ? (
          <>
            <AdminAction perm="templates.manage" size="sm" icon="send" busy={busy === "test"} onClick={() => void sendTest()}>
              Send test to me
            </AdminAction>
            <AdminAction perm="templates.manage" size="sm" icon="toggle_on" busy={busy === "status"} onClick={() => void setActive(!template.active)}>
              {template.active ? "Set to draft" : "Activate"}
            </AdminAction>
          </>
        ) : undefined
      }
    />
  );
}
