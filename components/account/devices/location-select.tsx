"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons/icon";
import { DisabledAction } from "@/components/account/disabled-action";
import { ROW_SELECT_TRIGGER, RowSelect } from "@/components/account/row-select";
import { toast } from "@/components/ui/sonner";
import type { TeamPermission } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { errorMessage, updateDevice } from "./api";
import { locationSelectValue, locationIdFromSelect, movedToast, UNASSIGNED_LABEL } from "./model";

export { UNASSIGNED_LABEL };

type LocationSelectProps = {
  device: { id: string; name: string; locationId: string | null };
  locations: readonly { id: string; name: string }[];
  /** The member's role lacks this permission: the select shows disabled with "Requires {roles}" (decisions.md). */
  disabledPerm?: TeamPermission;
  className?: string;
};

/**
 * Per-row location picker (prototype "Location for {name}"): saves with PATCH /api/account/devices/:id once an
 * option is chosen (Enter or a click; arrow keys only browse) and toasts "{name} moved to {location}". The new value
 * shows at once and goes back if the server refuses. For active devices; roles without devices.manage get it
 * disabled with the "Requires …" tooltip, like Deactivate.
 */
export function LocationSelect({ disabledPerm, ...props }: LocationSelectProps) {
  return disabledPerm ? <LockedLocationSelect {...props} perm={disabledPerm} /> : <EditableLocationSelect {...props} />;
}

function currentName(locationId: string | null, locations: LocationSelectProps["locations"]): string {
  return (locationId ? locations.find((l) => l.id === locationId)?.name : undefined) ?? UNASSIGNED_LABEL;
}

function EditableLocationSelect({ device, locations, className }: Omit<LocationSelectProps, "disabledPerm">) {
  const router = useRouter();
  const [value, setValue] = React.useState(device.locationId);
  const [busy, setBusy] = React.useState(false);
  const [synced, setSynced] = React.useState(device.locationId);
  if (device.locationId !== synced) {
    // Fresh server data (router.refresh) wins.
    setSynced(device.locationId);
    setValue(device.locationId);
  }

  const change = async (next: string | null) => {
    if (busy || next === value) return;
    const previous = value;
    setValue(next);
    setBusy(true);
    try {
      await updateDevice(device.id, { locationId: next });
      toast.success(movedToast(device.name, currentName(next, locations)));
      router.refresh();
    } catch (error) {
      setValue(previous);
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const known = value === null || locations.some((l) => l.id === value);
  const options = React.useMemo(
    () => [{ value: locationSelectValue(null), label: UNASSIGNED_LABEL }, ...locations.map((l) => ({ value: l.id, label: l.name }))],
    [locations],
  );
  return (
    <RowSelect
      label={`Location for ${device.name}`}
      value={locationSelectValue(known ? value : null)}
      options={options}
      busy={busy}
      onValueChange={(next) => void change(locationIdFromSelect(next))}
      className={cn("max-w-[240px] font-semibold", className)}
    />
  );
}

function LockedLocationSelect({ device, locations, perm, className }: Omit<LocationSelectProps, "disabledPerm"> & { perm: TeamPermission }) {
  const name = currentName(device.locationId, locations);
  return (
    <DisabledAction perm={perm} asChild>
      <button
        type="button"
        aria-label={`Location for ${device.name}: ${name}`}
        className={cn(
          ROW_SELECT_TRIGGER,
          "inline-flex max-w-[240px] items-center justify-between border bg-surface font-semibold text-ink hover:border-line-strong",
          className,
        )}
      >
        <span className="min-w-0 truncate">{name}</span>
        <Icon name="expand_more" size={20} className="shrink-0 text-ink-3" />
      </button>
    </DisabledAction>
  );
}
