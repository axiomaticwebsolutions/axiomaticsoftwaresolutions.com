"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/sonner";
import { DIALOG_INPUT, DIALOG_LABEL, PortalDialog } from "@/components/account/licenses/portal-dialog";
import { DEVICE_NAME_MAX, deviceNameSchema } from "@/lib/validation/license-actions";
import { ApiClientError } from "@/lib/client/api";
import { errorMessage, runDeactivations, updateDevice, type DeviceTarget } from "./api";
import { bulkDeactivateCopy, deactivatedToast, singleDeactivateCopy, skippedDevicesNote } from "./model";

/** "Rename device": one field, saved with PATCH /api/account/devices/:id (new UI; the API exists since Phase 4). */
export function RenameDeviceDialog({
  device,
  onOpenChange,
}: {
  device: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const inputId = React.useId();
  const [name, setName] = React.useState(device?.name ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [shown, setShown] = React.useState(device);
  if (device && device !== shown) {
    // A new device opens the dialog: start from its name.
    setShown(device);
    setName(device.name);
    setError(null);
  }

  const save = async () => {
    if (!device) return;
    const parsed = deviceNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a device name.");
      return;
    }
    if (parsed.data === device.name) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateDevice(device.id, { name: parsed.data });
      setBusy(false);
      onOpenChange(false);
      toast.success("Device renamed");
      router.refresh();
    } catch (cause) {
      setBusy(false);
      const fieldError = cause instanceof ApiClientError ? cause.fieldErrors.name?.[0] : undefined;
      setError(fieldError ?? errorMessage(cause));
    }
  };

  return (
    <PortalDialog
      open={device !== null}
      onOpenChange={onOpenChange}
      title="Rename device"
      description="The name shows in your device lists and the activity log. The software on the computer is not affected."
      confirmLabel="Save"
      onConfirm={save}
      busy={busy}
      error={error}
    >
      <label htmlFor={inputId} className={DIALOG_LABEL}>
        Device name
        <input
          id={inputId}
          type="text"
          value={name}
          maxLength={DEVICE_NAME_MAX + 20}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          onChange={(event) => setName(event.target.value)}
          className={DIALOG_INPUT}
        />
      </label>
    </PortalDialog>
  );
}

export type DeactivateRequest = {
  devices: DeviceTarget[];
  /** Selected devices that cannot be deactivated now (they are not sent). */
  skipped: number;
  /** "single": the license Devices tab copy with the deactivations left; "bulk": the fleet copy. */
  mode: "single" | "bulk";
  /** Self-service deactivations left on the license (single) or the yearly limit (bulk). */
  left: number;
  perYear: number;
};

/**
 * Danger confirmation for one or more devices. Requests run one at a time; a single device toasts
 * "{name} deactivated · 1 slot free", several "{n} devices deactivated (· some were skipped)". When nothing could be
 * deactivated the server's message (e.g. the yearly limit) stays in the dialog. After a deactivation the button that
 * opened the dialog goes away (the bulk bar closes, the row loses its actions or leaves the list once refreshed), so
 * focus moves to `focusAfterDone` (a stable element: the table, the section heading) instead of falling to <body>.
 */
export function DeactivateDevicesDialog({
  request,
  onOpenChange,
  onDone,
  focusAfterDone,
}: {
  request: DeactivateRequest | null;
  onOpenChange: (open: boolean) => void;
  onDone?: (deactivatedIds: string[]) => void;
  focusAfterDone?: () => HTMLElement | null;
}) {
  const router = useRouter();
  const doneRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [shown, setShown] = React.useState(request);
  if (request && request !== shown) {
    setShown(request);
    setError(null);
  }
  const current = request ?? shown;
  const names = current?.devices.map((d) => d.name) ?? [];
  const copy =
    current?.mode === "single"
      ? singleDeactivateCopy(names[0] ?? "", current.left)
      : bulkDeactivateCopy(names, current?.perYear ?? 3);

  const confirm = async () => {
    if (!current || current.devices.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await runDeactivations(current.devices);
    setBusy(false);
    if (result.ok.length === 0) {
      setError(result.lastError ?? "We couldn’t deactivate these devices. Please try again.");
      return;
    }
    doneRef.current = true;
    onOpenChange(false);
    const skipped = result.failed.length > 0 || current.skipped > 0;
    const first = result.ok[0];
    toast.success(
      current.mode === "single" && first && !skipped ? `${first.name} deactivated · 1 slot free` : deactivatedToast(result.ok.length, skipped),
    );
    onDone?.(result.ok.map((d) => d.id));
    router.refresh();
  };

  return (
    <PortalDialog
      open={request !== null}
      onOpenChange={onOpenChange}
      tone="danger"
      title={copy.title}
      description={copy.body}
      confirmLabel="Deactivate"
      onConfirm={confirm}
      busy={busy}
      confirmDisabled={!current || current.devices.length === 0}
      error={error}
      fallbackFocus={focusAfterDone}
      onCloseAutoFocus={(event) => {
        if (!doneRef.current) return;
        doneRef.current = false;
        const target = focusAfterDone?.();
        if (!target) return;
        event.preventDefault();
        target.focus();
      }}
    >
      {current && current.skipped > 0 ? (
        <p className="mb-0 mt-3 rounded-10 bg-peach-bg px-3 py-2.5 text-[13.5px] font-bold text-peach-fg">
          {skippedDevicesNote(current.skipped)}
        </p>
      ) : null}
    </PortalDialog>
  );
}
