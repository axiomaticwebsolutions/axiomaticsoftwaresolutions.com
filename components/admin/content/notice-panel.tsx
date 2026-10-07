"use client";

import * as React from "react";
import { useCan } from "@/components/admin/admin-context";
import { formErrorsFrom } from "@/components/admin/coupons/form-errors";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { CONTENT_NOTICE_COPY, FAQ_COPY, NOTICE_TEXT_MAX, type ContentNoticeDto, type ContentNoticeKey } from "@/lib/admin/content/model";
import { apiFetch } from "@/lib/client/api";

type Props = { noticeKey: ContentNoticeKey; notice: ContentNoticeDto };

/**
 * Storefront notice card (prototype "Site announcement banner"): a switch that shows or hides it right away and the
 * text with Save. Both revalidate the storefront. Disabled for roles without content.manage.
 */
export function NoticePanel({ noticeKey, notice }: Props) {
  const copy = CONTENT_NOTICE_COPY[noticeKey];
  const canManage = useCan("content.manage");
  const headingId = React.useId();
  const descId = React.useId();
  const errorId = React.useId();
  const [enabled, setEnabled] = React.useState(notice.enabled);
  const [saved, setSaved] = React.useState(notice.text);
  const [text, setText] = React.useState(notice.text);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"toggle" | "save" | null>(null);

  async function send(body: { enabled?: boolean; text?: string }, kind: "toggle" | "save") {
    setBusy(kind);
    try {
      const res = await apiFetch<{ notice: ContentNoticeDto; changed: boolean }>(`/api/admin/content/${noticeKey}`, { method: "PATCH", body });
      setEnabled(res.notice.enabled);
      setSaved(res.notice.text);
      if (kind === "save") setText(res.notice.text);
      setError(null);
      toast.success(!res.changed ? FAQ_COPY.noChanges : kind === "save" ? copy.saved : copy.on);
    } catch (e) {
      const errs = formErrorsFrom(e);
      setError(errs.fields.text ?? errs.form);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby={headingId} className="grid gap-2.5 rounded-14 border border-line-alt bg-surface px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="m-0 text-[14.5px] font-extrabold leading-[normal]">
            {copy.title}
          </h2>
          <p id={descId} className="m-0 mt-0.5 text-[12.5px] leading-[normal] text-ink-2">
            {copy.description}
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={!canManage || busy !== null}
          aria-labelledby={headingId}
          aria-describedby={descId}
          onCheckedChange={(next) => void send({ enabled: next, ...(text !== saved ? { text } : {}) }, "toggle")}
        />
      </div>
      <form
        noValidate
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() === saved.trim()) {
            toast.success(FAQ_COPY.noChanges);
            return;
          }
          void send({ text }, "save");
        }}
      >
        <Input
          size="sm"
          aria-label={copy.inputLabel}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          maxLength={NOTICE_TEXT_MAX}
          disabled={!canManage}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-[38px] flex-[1_1_300px] rounded-9 px-3 font-semibold"
        />
        <Button type="submit" variant="primary" size="sm" loading={busy === "save"} disabled={!canManage} className="h-[38px] rounded-9 px-3.5">
          Save
        </Button>
        {error ? (
          <FieldError id={errorId} className="basis-full">
            {error}
          </FieldError>
        ) : null}
      </form>
    </section>
  );
}
