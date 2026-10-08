"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { adminToast } from "@/components/admin/admin-toaster";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import {
  clearDialogBody,
  INTEGRATIONS_COPY,
  removeDialogBody,
  type IntegrationClearResponse,
  type IntegrationForm,
  type IntegrationRemoveResponse,
  type IntegrationSaveResponse,
  type IntegrationState,
} from "@/lib/admin/settings/integrations-model";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { fieldLabel, type EmailSecurity, type SecretField as SecretFieldKey, type StoragePreset } from "@/lib/integrations/model";
import type { ProbeResult } from "@/lib/integrations/types";
import { cn } from "@/lib/utils";
import {
  applyPreset,
  applyRegion,
  applySecurity,
  bodyFor,
  cardNote,
  clientErrors,
  dirtyKeys,
  endpointPlaceholder,
  fieldDomKey,
  hasChanges,
  INTEGRATION_FIELDS,
  orderedErrorKeys,
  presetHint,
  providerSwitchNote,
  requiredSecretFields,
  secretHintOf,
  secretHintSource,
  secretInputHint,
  secretsToReenter,
  serverFieldErrors,
  testButtonState,
  toDraft,
  visibleFields,
  type IntegrationDraft,
  type IntegrationFieldDef,
} from "./integration-form-model";
import { EnvNamesLine, IntegrationBadges, IntegrationProblem, ProbeSteps } from "./integration-parts";
import { PasswordDialog, type PasswordOutcome } from "./password-dialog";
import { replaceButtonId, SecretField } from "./secret-field";
import { SETTINGS_GRID_CLASS, SettingsCard } from "./settings-card";

/** An integration the signed-in Owner may edit (the server sends `form` only with integrations.manage). */
export type ManagedIntegration = IntegrationState & { form: IntegrationForm };

/** `removes`: the sentence about a saved secret the save deletes (email provider switch), fixed when the dialog opens. */
type DialogState = { action: "save"; removes: string | null } | { action: "clear"; field: SecretFieldKey } | { action: "remove" };

const text = (v: IntegrationDraft[string] | undefined) => (typeof v === "string" ? v : "");

/**
 * Password managers must leave every integration input alone: the identifier inputs (Key ID, access key IDs, SMTP
 * username, bucket) got the Owner's saved Admin email filled in live. Their names and ids never look like a sign-in
 * field (fieldDomKey), autocomplete is off, and these attributes opt out of 1Password, LastPass, Bitwarden and Dashlane.
 * Secret inputs carry them too (secret-field.tsx), with autocomplete="new-password".
 */
const NO_PASSWORD_MANAGER = {
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
} as const;

/**
 * A storage change reloads the page so the new Content-Security-Policy (which names the bucket) applies at once; the
 * success message is handed to the reloaded card through sessionStorage (read once; blocked storage only loses the
 * toast).
 */
const RELOAD_FLASH_KEY = "axiomatic.integrationFlash";

function reloadWithFlash(kind: string, message: string): void {
  try {
    window.sessionStorage.setItem(RELOAD_FLASH_KEY, JSON.stringify({ v: 1, kind, message }));
  } catch {
    // the reload still applies the new policy
  }
  window.location.reload();
}

function takeReloadFlash(kind: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_FLASH_KEY);
    if (!raw) return null;
    const flash = JSON.parse(raw) as { v?: unknown; kind?: unknown; message?: unknown };
    if (flash.kind !== kind) return null;
    window.sessionStorage.removeItem(RELOAD_FLASH_KEY);
    return flash.v === 1 && typeof flash.message === "string" && flash.message.length <= 200 ? flash.message : null;
  } catch {
    return null;
  }
}

function SwitchRow({
  id,
  field,
  checked,
  onChange,
  error,
}: {
  id: string;
  field: IntegrationFieldDef;
  checked: boolean;
  onChange: (value: boolean) => void;
  error?: string;
}) {
  const hintId = field.hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="col-span-full grid gap-1.5">
      <div className="flex items-start justify-between gap-3 rounded-10 border border-line-subtle bg-bg px-3 py-2.5">
        <div className="grid min-w-0 gap-0.5">
          <label htmlFor={id} className="cursor-pointer text-[12.5px] font-bold">
            {field.label}
          </label>
          {field.hint ? (
            <p id={hintId} className="m-0 text-[12px] text-ink-2">
              {field.hint}
            </p>
          ) : null}
        </div>
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onChange}
          aria-describedby={[errorId, hintId].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : undefined}
        />
      </div>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

/**
 * One integration as the Owner's form (Admin > Settings > Integrations; docs/admin-integrations-design.md section 17):
 * badges (source, development, mode), the problem line, the fields with write-only secrets, the payments webhook URL,
 * the inline test result; footer with who saved it, Remove saved settings, the test button and Save.
 *
 * Save: client checks with the shared schemas, then the password dialog, then PUT. Field errors from the server show
 * under their fields (the first one gets focus); a wrong password stays in the dialog. Clear and Remove also go
 * through the dialog. The test button needs a configured integration and no unsaved changes. Secret values live only
 * in the draft until the save answers, and are dropped then. A new email provider, SMTP server, SES region or storage
 * endpoint opens the saved secrets for entry (the server refuses to keep them for another server). Email shows the
 * fields of the chosen provider (SMTP or Amazon SES) only; switching provider says under Provider and in the save dialog
 * that Save deletes the other provider's saved secret (providerSwitchNote). A storage save, clear or remove reloads the page, so its
 * Content-Security-Policy names the new bucket before the next upload. The form and every input opt out of password
 * managers (NO_PASSWORD_MANAGER, secret-field.tsx; docs/decisions.md 2026-10-08 autofill).
 */
export function IntegrationCard({ initial }: { initial: ManagedIntegration }) {
  const router = useRouter();
  const uid = React.useId();
  const [state, setState] = React.useState<ManagedIntegration>(initial);
  const form = state.form;
  const kind = state.id;
  const [baseline, setBaseline] = React.useState<IntegrationDraft>(() => toDraft(initial.form));
  const [draft, setDraft] = React.useState<IntegrationDraft>(baseline);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [replacing, setReplacing] = React.useState<Record<string, boolean>>({});
  // The last action stays set while the dialog closes, so its text does not change during the closing animation.
  const [dialog, setDialog] = React.useState<DialogState | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const openDialog = (next: DialogState) => {
    setDialog(next);
    setDialogOpen(true);
  };
  const [presetNote, setPresetNote] = React.useState<string | null>(null);
  const [probe, setProbe] = React.useState<ProbeResult | null>(null);
  const [probing, setProbing] = React.useState(false);

  // After a storage change reloaded the page: its success message (deferred until the toaster is mounted).
  React.useEffect(() => {
    const message = takeReloadFlash(kind);
    if (message) window.setTimeout(() => adminToast.success(message), 0);
  }, [kind]);

  const domKeys = React.useMemo(() => new Map(INTEGRATION_FIELDS[kind].map((f) => [f.key, fieldDomKey(f)])), [kind]);
  const fieldId = (key: string) => `${uid}-${domKeys.get(key) ?? key}`;
  const revision = state.saved?.revision ?? null;
  // Saved secrets that a new email provider, SMTP server, SES region or endpoint needs entered again (the server
  // refuses to keep them).
  const reenter = secretsToReenter(form, draft);
  const dirty = dirtyKeys(kind, baseline, draft);
  // Switching the email provider deletes the other provider's saved secret on Save: said under Provider and in the dialog.
  const switchNote = providerSwitchNote(form, draft);
  const test = testButtonState(state, dirty.length > 0);
  const testHintId = `${uid}-test-hint`;

  const focusField = (key: string | undefined) => {
    if (!key) return;
    window.requestAnimationFrame(() => {
      const target = document.getElementById(fieldId(key)) ?? document.getElementById(replaceButtonId(fieldId(key)));
      target?.focus();
    });
  };

  function set(key: string, value: string | boolean) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: "" } : e));
  }

  function change(key: string, value: string | boolean) {
    let next: IntegrationDraft;
    if (key === "preset") {
      const preset = value as StoragePreset;
      next = applyPreset(draft, preset);
      setPresetNote(presetHint(preset));
      setErrors((e) => ({ ...e, preset: "", endpoint: "", region: "", forcePathStyle: "" }));
    } else if (key === "security") {
      next = applySecurity(draft, value as EmailSecurity);
      setErrors((e) => ({ ...e, security: "", port: "" }));
    } else if (key === "region" && kind === "storage") {
      next = applyRegion(draft, String(value));
      setErrors((e) => ({ ...e, region: "", endpoint: "" }));
    } else if (key === "provider") {
      // SMTP <-> Amazon SES: the other provider's fields hide, so their errors go too.
      next = { ...draft, provider: value };
      setErrors({});
    } else {
      next = { ...draft, [key]: value };
      setErrors((e) => (e[key] ? { ...e, [key]: "" } : e));
    }
    setDraft(next);
    // A new email provider, SMTP server, SES region or endpoint: open the saved secrets for entry (they cannot be kept
    // for another server).
    const open = secretsToReenter(form, next);
    if (open.length > 0) setReplacing((r) => (open.every((f) => r[f]) ? r : { ...r, ...Object.fromEntries(open.map((f) => [f, true])) }));
  }

  /** The server's view after a save, clear or remove: new baseline, secrets dropped, Replace closed. */
  function adopt(next: IntegrationState) {
    if (!next.form) return;
    const fresh = toDraft(next.form);
    setState({ ...next, form: next.form });
    setBaseline(fresh);
    setDraft(fresh);
    setReplacing({});
    setErrors({});
    setPresetNote(null);
  }

  /** Maps a failed request to what the password dialog does with it. */
  function outcomeFor(error: unknown): PasswordOutcome {
    if (!(error instanceof ApiClientError)) return { status: "error", message: UNEXPECTED_ERROR_MESSAGE };
    if (error.code === "incorrect_password") return { status: "password", message: error.message };
    if (error.status === 422) {
      const passwordError = error.fieldErrors.currentPassword?.[0];
      if (passwordError) return { status: "password", message: passwordError };
      const fields = serverFieldErrors(error.fieldErrors);
      const first = orderedErrorKeys(kind, fields)[0];
      if (first) {
        setErrors(fields);
        return { status: "close", focus: () => focusField(first) };
      }
    }
    return { status: "error", message: error.message };
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dialogOpen) return;
    if (!hasChanges(state, kind, baseline, draft)) {
      adminToast.success(INTEGRATIONS_COPY.toasts.noChanges);
      return;
    }
    const local = clientErrors(form, draft, revision);
    const first = orderedErrorKeys(kind, local)[0];
    if (first) {
      setErrors(local);
      focusField(first);
      return;
    }
    openDialog({ action: "save", removes: switchNote });
  }

  async function confirm(password: string): Promise<PasswordOutcome> {
    if (!dialog) return { status: "done" };
    const base = `/api/admin/settings/integrations/${kind}`;
    try {
      if (dialog.action === "save") {
        const firstSave = state.saved === null;
        const res = await apiFetch<IntegrationSaveResponse>(base, { method: "PUT", body: bodyFor(kind, draft, password, revision) });
        adopt(res.integration);
        setProbe(null);
        const changed = res.changed.length > 0 || firstSave;
        if (changed && kind === "storage") {
          reloadWithFlash(kind, INTEGRATIONS_COPY.toasts.saved(state.title));
          return { status: "done" };
        }
        adminToast.success(changed ? INTEGRATIONS_COPY.toasts.saved(state.title) : INTEGRATIONS_COPY.toasts.noChanges);
        router.refresh();
        return { status: "done" };
      }
      if (dialog.action === "clear") {
        const field = dialog.field;
        const res = await apiFetch<IntegrationClearResponse>(`${base}/secrets/${field}`, { method: "DELETE", body: { currentPassword: password } });
        adopt(res.integration);
        setProbe(null);
        if (res.cleared && kind === "storage") {
          reloadWithFlash(kind, INTEGRATIONS_COPY.toasts.cleared(fieldLabel(kind, field)));
          return { status: "done" };
        }
        adminToast.success(INTEGRATIONS_COPY.toasts.cleared(fieldLabel(kind, field)));
        router.refresh();
        // The Clear button is gone: focus the now empty input.
        return { status: "close", focus: () => focusField(field) };
      }
      const res = await apiFetch<IntegrationRemoveResponse>(base, { method: "DELETE", body: { currentPassword: password } });
      adopt(res.integration);
      setProbe(null);
      if (kind === "storage") {
        reloadWithFlash(kind, INTEGRATIONS_COPY.toasts.removed);
        return { status: "done" };
      }
      adminToast.success(INTEGRATIONS_COPY.toasts.removed);
      router.refresh();
      return { status: "close", focus: () => focusField(INTEGRATION_FIELDS[kind][0]?.key) };
    } catch (error) {
      return outcomeFor(error);
    }
  }

  async function runTest() {
    if (!test.enabled || probing) return;
    setProbing(true);
    // Empty the live region first, so a repeated result is announced again.
    setProbe(null);
    try {
      setProbe(await apiFetch<ProbeResult>(`/api/admin/settings/integrations/${kind}/test`, { method: "POST", body: {} }));
    } catch (error) {
      adminToast.error(error);
    } finally {
      setProbing(false);
    }
  }

  const dialogCopy =
    dialog?.action === "clear"
      ? {
          description: clearDialogBody(kind, dialog.field, requiredSecretFields(kind, baseline).includes(dialog.field)),
          confirmLabel: INTEGRATIONS_COPY.dialog.clear,
          tone: "danger" as const,
        }
      : dialog?.action === "remove"
        ? { description: removeDialogBody(kind), confirmLabel: INTEGRATIONS_COPY.dialog.remove, tone: "danger" as const }
        : {
            description: [INTEGRATIONS_COPY.dialog.body(state.title), dialog?.action === "save" ? dialog.removes : null].filter(Boolean).join(" "),
            confirmLabel: INTEGRATIONS_COPY.dialog.save,
            tone: "primary" as const,
          };

  function renderField(def: IntegrationFieldDef) {
    const id = fieldId(def.key);
    const name = fieldDomKey(def);
    const error = errors[def.key] || undefined;
    const wide = def.wide ? "col-span-full" : undefined;
    if (def.kind === "secret") {
      const field = def.key as SecretFieldKey;
      const hint = secretHintOf(form, field);
      const unused = kind === "email" && field === "password" && text(draft.username).trim() === "";
      const mustReenter = reenter.includes(field);
      return (
        <SecretField
          key={def.key}
          id={id}
          name={name}
          label={def.label}
          hint={def.hint}
          secret={hint}
          value={text(draft[field])}
          onChange={(value) => set(field, value)}
          error={error}
          required={mustReenter || (!hint.set && requiredSecretFields(kind, draft).includes(field))}
          replacing={replacing[field] === true}
          onReplace={() => {
            setReplacing((r) => ({ ...r, [field]: true }));
            focusField(field);
          }}
          onCancelReplace={() => {
            setReplacing((r) => ({ ...r, [field]: false }));
            set(field, "");
            window.requestAnimationFrame(() => document.getElementById(replaceButtonId(id))?.focus());
          }}
          onClear={() => openDialog({ action: "clear", field })}
          inputHint={secretInputHint({
            kind,
            replacing: replacing[field] === true,
            source: secretHintSource(state.source, kind, baseline, draft),
            saved: state.saved !== null,
            unused,
            reenter: mustReenter,
          })}
          className={wide}
        />
      );
    }
    if (def.kind === "switch") {
      return <SwitchRow key={def.key} id={id} field={def} checked={draft[def.key] === true} onChange={(v) => change(def.key, v)} error={error} />;
    }
    const isEndpoint = def.key === "endpoint";
    const hint = def.key === "preset" ? (presetNote ?? def.hint) : def.key === "provider" ? (switchNote ?? def.hint) : def.hint;
    return (
      <Field key={def.key} id={id} size="sm" label={def.label} hint={hint} error={error} className={cn("content-start gap-[5px]", wide)}>
        {def.kind === "select" ? (
          <NativeSelect
            size="sm"
            name={name}
            autoComplete="off"
            {...NO_PASSWORD_MANAGER}
            value={text(draft[def.key])}
            onChange={(e) => change(def.key, e.target.value)}
            className="font-semibold"
          >
            {(def.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Input
            size="sm"
            mono={def.mono}
            name={name}
            type={def.kind === "number" ? "number" : def.kind === "email" ? "email" : "text"}
            inputMode={def.inputMode}
            min={def.kind === "number" ? 1 : undefined}
            max={def.kind === "number" ? 65_535 : undefined}
            step={def.kind === "number" ? 1 : undefined}
            maxLength={def.kind === "number" ? undefined : def.maxLength}
            autoComplete="off"
            {...NO_PASSWORD_MANAGER}
            spellCheck={false}
            autoCapitalize="off"
            placeholder={isEndpoint ? endpointPlaceholder(text(draft.preset) as StoragePreset) || undefined : undefined}
            value={text(draft[def.key])}
            onChange={(e) => change(def.key, e.target.value)}
            className="font-semibold"
          />
        )}
      </Field>
    );
  }

  const webhook = form.kind === "payments" ? form : null;
  return (
    <>
      <SettingsCard
        as="form"
        id={`integration-${kind}`}
        autoComplete="off"
        headingLevel={3}
        icon={state.icon}
        title={state.title}
        description={state.description}
        onSubmit={submit}
        note={cardNote(state)}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {state.saved ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="px-3 py-[7px] text-[13px] text-danger hover:bg-pink-bg hover:text-danger"
                onClick={() => openDialog({ action: "remove" })}
              >
                {INTEGRATIONS_COPY.remove}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="px-3 py-[7px] text-[13px]"
              disabled={!test.enabled}
              loading={probing}
              aria-describedby={test.hint ? testHintId : undefined}
              onClick={runTest}
            >
              {INTEGRATIONS_COPY.probe[kind]}
            </Button>
            <Button type="submit" size="sm" className="px-3.5 py-[7px] text-[13px]">
              {INTEGRATIONS_COPY.save}
            </Button>
          </div>
        }
      >
        <div className="grid gap-2.5 px-4 pt-3.5">
          <IntegrationBadges state={state} />
          <EnvNamesLine state={state} />
          <IntegrationProblem problem={state.problem} />
        </div>
        <div className={SETTINGS_GRID_CLASS}>
          {visibleFields(kind, draft).map(renderField)}
          {webhook ? (
            <Field
              id={fieldId("webhookUrl")}
              size="sm"
              label={INTEGRATIONS_COPY.webhookUrl}
              hint={
                webhook.lastSignedWebhookAt
                  ? `${INTEGRATIONS_COPY.webhookUrlHint} ${INTEGRATIONS_COPY.lastWebhook(webhook.lastSignedWebhookAt)}`
                  : INTEGRATIONS_COPY.webhookUrlHint
              }
              className="col-span-full content-start gap-[5px]"
            >
              <Input
                size="sm"
                mono
                readOnly
                name="razorpay-webhook-url"
                autoComplete="off"
                {...NO_PASSWORD_MANAGER}
                spellCheck={false}
                value={webhook.webhookUrl}
                className="font-semibold"
              />
            </Field>
          ) : null}
          {kind === "storage" ? <p className="col-span-full m-0 text-[12px] text-ink-2">{INTEGRATIONS_COPY.storageHelp}</p> : null}
          {kind === "email" && draft.provider === "ses" ? <p className="col-span-full m-0 text-[12px] text-ink-2">{INTEGRATIONS_COPY.sesHelp}</p> : null}
        </div>
        <div className="grid gap-2 px-4 pb-3.5">
          <span className="sr-only" aria-live="polite">
            {presetNote ?? ""}
          </span>
          {test.hint ? (
            <p id={testHintId} className="m-0 text-[12px] font-semibold text-ink-2">
              {test.hint}
            </p>
          ) : null}
          <div role="status" aria-live="polite">
            {probe ? <ProbeSteps result={probe} title={INTEGRATIONS_COPY.probeResult} /> : null}
          </div>
        </div>
      </SettingsCard>
      <PasswordDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        description={dialogCopy.description}
        confirmLabel={dialogCopy.confirmLabel}
        tone={dialogCopy.tone}
        onConfirm={confirm}
      />
    </>
  );
}
