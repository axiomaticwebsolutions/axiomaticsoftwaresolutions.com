"use client";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { INTEGRATIONS_COPY, type SecretHint } from "@/lib/admin/settings/integrations-model";
import { cn } from "@/lib/utils";
import { secretSummary } from "./integration-form-model";

export type SecretFieldProps = {
  /** The input's id (also the base of the Replace button's id). */
  id: string;
  /** The input's name: never one that looks like a sign-in field (integration-form-model.ts fieldDomKey). */
  name?: string;
  label: string;
  /** The field's own help (e.g. where the webhook secret comes from). */
  hint?: string;
  /** What Admin has saved for this secret (never the value). */
  secret: SecretHint;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  /** Needed when nothing is saved (e.g. the key secret of a first save). */
  required: boolean;
  /** The Owner chose Replace: an empty input instead of the saved summary. */
  replacing: boolean;
  onReplace: () => void;
  onCancelReplace: () => void;
  onClear: () => void;
  /** Extra help under the input ("Leave empty to keep the saved value.", "In the server file..."). */
  inputHint: string | null;
  className?: string;
};

export const replaceButtonId = (id: string) => `${id}-replace`;

/**
 * A write-only secret (Admin > Settings > Integrations). Saved: "Set (ends 1a2b)", who changed it and when, Replace and
 * Clear. Replace swaps in an empty password input with Cancel; leaving it empty keeps the saved value. Nothing saved:
 * the input shows directly. The value is never prefilled, never echoed and dropped from state after a save.
 *
 * Password managers: autocomplete="new-password" plus the managers' ignore attributes. Chrome ignores
 * autocomplete="off" on password inputs and filled the Owner's saved Admin sign-in into these forms (email into Key ID,
 * password into Key secret); it never fills a saved password into a new-password input (docs/decisions.md,
 * 2026-10-08, reverses the earlier autocomplete="off").
 */
export function SecretField({
  id,
  name,
  label,
  hint,
  secret,
  value,
  onChange,
  error,
  required,
  replacing,
  onReplace,
  onCancelReplace,
  onClear,
  inputHint,
  className,
}: SecretFieldProps) {
  if (secret.set && !replacing) {
    const { summary, changed } = secretSummary(secret);
    const labelId = `${id}-label`;
    const summaryId = `${id}-summary`;
    const errorId = error ? `${id}-error` : undefined;
    const hintId = hint ? `${id}-hint` : undefined;
    return (
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={[summaryId, errorId, hintId].filter(Boolean).join(" ")}
        className={cn("grid content-start gap-[5px]", className)}
      >
        <span id={labelId} className="text-[12.5px] font-bold text-ink">
          {label}
        </span>
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 rounded-8 border border-line-input bg-bg px-2.5 py-1.5">
          <div id={summaryId} className="grid min-w-0">
            <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
              <Icon name="lock" size={16} className="shrink-0 text-ink-2" />
              {summary}
            </span>
            {changed ? <span className="text-[12px] text-ink-2">{changed}</span> : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              id={replaceButtonId(id)}
              type="button"
              size="sm"
              variant="secondary"
              className="px-2.5 py-1 text-[12.5px]"
              aria-label={`${INTEGRATIONS_COPY.secret.replace} ${label}`}
              onClick={onReplace}
            >
              {INTEGRATIONS_COPY.secret.replace}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive-outline"
              className="px-2.5 py-1 text-[12.5px]"
              aria-label={`${INTEGRATIONS_COPY.secret.clear} ${label}`}
              onClick={onClear}
            >
              {INTEGRATIONS_COPY.secret.clear}
            </Button>
          </div>
        </div>
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
        {hint ? (
          <p id={hintId} className="text-[12px] text-ink-2">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }

  const help = [inputHint, hint].filter(Boolean).join(" ") || undefined;
  return (
    <Field
      id={id}
      size="sm"
      label={label}
      hint={help}
      error={error}
      required={required}
      className={cn("content-start gap-[5px]", className)}
      labelAction={
        replacing ? (
          <Button
            type="button"
            variant="link"
            className="text-[12.5px]"
            aria-label={`${INTEGRATIONS_COPY.secret.cancel} replacing ${label}`}
            onClick={onCancelReplace}
          >
            {INTEGRATIONS_COPY.secret.cancel}
          </Button>
        ) : null
      }
    >
      <Input
        size="sm"
        mono
        type="password"
        name={name}
        // Not a sign-in password: "new-password" stops Chrome filling the Owner's saved sign-in password here (it
        // ignores "off" on password inputs); the ignore attributes keep 1Password, LastPass, Bitwarden and Dashlane
        // from saving or filling it (saving would copy the secret out of the encrypted store).
        autoComplete="new-password"
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore=""
        data-form-type="other"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
