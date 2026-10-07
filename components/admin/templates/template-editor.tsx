"use client";

import * as React from "react";
import { DrawerSubmit } from "@/components/admin/drawer";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_SUBJECT_LENGTH } from "@/lib/email/render";
import {
  previewTemplate,
  previewText,
  TEMPLATE_BODY_MAX,
  TEMPLATE_COPY,
  type TemplateDto,
  type TemplatePreviewContext,
} from "@/lib/admin/templates/model";

export type TemplateDraft = { subject: string; body: string };

type Props = {
  template: TemplateDto;
  draft: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
  errors: Record<string, string>;
  formError: string | null;
  busy: boolean;
  onSubmit: () => void;
  preview: TemplatePreviewContext;
};

type Target = "subject" | "body";

/**
 * Template "Content" form: Subject, Body (mono), the template's variables as chips that insert `{{name}}` at the
 * cursor of the last focused field, and the live preview with sample data through the email renderer (plain text
 * as prototyped, or the HTML email in a sandboxed frame).
 */
export function TemplateEditor({ template, draft, onChange, errors, formError, busy, onSubmit, preview }: Props) {
  const subjectRef = React.useRef<HTMLInputElement>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const lastFocus = React.useRef<Target>("body");
  const [mode, setMode] = React.useState<"text" | "email">("text");
  const deferred = React.useDeferredValue(draft);
  const rendered = React.useMemo(() => previewTemplate(template.id, deferred, preview), [template.id, deferred, preview]);
  const uid = React.useId();

  function insert(name: string) {
    const target = lastFocus.current;
    const el = target === "subject" ? subjectRef.current : bodyRef.current;
    const token = `{{${name}}}`;
    const value = draft[target];
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
    onChange({ ...draft, [target]: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <form
      noValidate
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {formError ? (
        <div role="alert" className="rounded-8 bg-pink-bg px-2.5 py-2 text-[13px] font-bold text-pink-fg">
          {formError}
        </div>
      ) : null}
      <Field label="Subject" size="sm" error={errors.subject} id={`${uid}-subject`}>
        <Input
          ref={subjectRef}
          size="sm"
          maxLength={MAX_SUBJECT_LENGTH}
          value={draft.subject}
          onFocus={() => (lastFocus.current = "subject")}
          onChange={(e) => onChange({ ...draft, subject: e.target.value })}
        />
      </Field>
      <Field label="Body" size="sm" error={errors.body} hint="Separate paragraphs with a blank line." id={`${uid}-body`}>
        <Textarea
          ref={bodyRef}
          size="sm"
          rows={8}
          maxLength={TEMPLATE_BODY_MAX}
          className="font-mono text-[13px]"
          value={draft.body}
          onFocus={() => (lastFocus.current = "body")}
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
        />
      </Field>
      {template.vars.length > 0 ? (
        <div className="grid min-w-0 gap-1.5">
          <p id={`${uid}-vars`} className="m-0 text-[12.5px] font-bold">
            Variables <span className="font-semibold text-ink-2">· {TEMPLATE_COPY.varsHint}</span>
          </p>
          <ul aria-labelledby={`${uid}-vars`} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {template.vars.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(name)}
                  aria-label={`Insert ${name}`}
                  className="cursor-pointer rounded-pill border border-lavender-line bg-lavender-soft px-2 py-0.5 font-mono text-[12px] font-semibold text-lavender-fg transition-colors hover:bg-lavender-bg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {`{{${name}}}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="min-w-0 rounded-9 border border-dashed border-line-input bg-bg px-3 py-2.5 text-[13px] leading-[1.55]">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-[11px] font-extrabold tracking-[0.06em] text-ink-2">PREVIEW WITH SAMPLE DATA</p>
          <div role="group" aria-label="Preview format" className="flex gap-1">
            {(["text", "email"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className="cursor-pointer rounded-6 px-2 py-0.5 text-[11.5px] font-bold text-ink-2 aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-sm"
              >
                {m === "text" ? "Text" : "Email"}
              </button>
            ))}
          </div>
        </div>
        {mode === "text" ? (
          <div aria-live="polite" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {previewText(rendered)}
          </div>
        ) : (
          <iframe
            title={`Email preview: ${rendered.subject}`}
            srcDoc={rendered.html}
            sandbox=""
            className="h-[420px] w-full rounded-8 border border-line-alt bg-surface"
          />
        )}
        <p className="m-0 mt-1.5 text-[11.5px] font-semibold text-ink-2">{TEMPLATE_COPY.blocksNote}</p>
      </div>
      <DrawerSubmit loading={busy}>Save changes</DrawerSubmit>
    </form>
  );
}
