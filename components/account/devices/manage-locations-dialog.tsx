"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { DIALOG_INPUT } from "@/components/account/licenses/portal-dialog";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { LOCATION_NAME_MAX, locationNameSchema } from "@/lib/validation/portal";
import { cn } from "@/lib/utils";
import { errorMessage } from "./api";

type LocationRow = { id: string; name: string; activeDevices: number };
type LocationList = { locations: LocationRow[]; unassignedDevices: number };

const ICON_BUTTON =
  "grid size-8 shrink-0 cursor-pointer place-items-center rounded-8 text-ink-2 transition-colors hover:bg-lavender-bg hover:text-lavender-fg";
const ROW_BUTTON = "h-auto rounded-9 px-3 py-1.5 text-[13px]";

function devicesText(n: number): string {
  return `${n} active ${n === 1 ? "device" : "devices"}`;
}

function nameError(value: string): string | null {
  const parsed = locationNameSchema.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Enter a location name.");
}

function fieldMessage(error: unknown): string {
  return (error instanceof ApiClientError ? error.fieldErrors.name?.[0] : undefined) ?? errorMessage(error);
}

/**
 * "Manage locations" (decisions.md Phase 5; new UI, the prototype has none): add, rename and delete the business's
 * locations with the F3 locations API. Deleting asks inline and moves that location's devices to Unassigned.
 * Changes refresh the page so the fleet's location pickers and the sidebar switcher follow.
 */
export function ManageLocationsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        className="block max-w-[520px] rounded-18 p-[22px] leading-[normal] sm:p-[22px]"
      >
        {/* Content unmounts on close, so each opening loads the current list. */}
        <ManageLocations onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ManageLocations({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const addId = React.useId();
  const listRef = React.useRef<HTMLUListElement>(null);
  const addRef = React.useRef<HTMLInputElement>(null);
  const [data, setData] = React.useState<LocationList | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState("");
  const [addError, setAddError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<{ id: string; name: string; error: string | null } | null>(null);
  const [deleting, setDeleting] = React.useState<{ id: string; error: string | null } | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      setData(await apiFetch<LocationList>("/api/account/locations"));
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const focusRow = (id: string, action: "rename" | "delete") => {
    window.requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-location="${CSS.escape(id)}"] [data-action="${action}"]`)?.focus();
    });
  };

  const add = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (adding) return;
    const invalid = nameError(newName);
    if (invalid) {
      setAddError(invalid);
      addRef.current?.focus();
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const { location } = await apiFetch<{ location: LocationRow }>("/api/account/locations", { method: "POST", body: { name: newName } });
      setData((d) => (d ? { ...d, locations: [...d.locations, location].sort((a, b) => a.name.localeCompare(b.name)) } : d));
      setNewName("");
      toast.success(`${location.name} added`);
      router.refresh();
    } catch (error) {
      setAddError(fieldMessage(error));
    } finally {
      setAdding(false);
      addRef.current?.focus();
    }
  };

  const saveRename = async (id: string) => {
    if (!editing || busyId) return;
    const invalid = nameError(editing.name);
    if (invalid) {
      setEditing({ ...editing, error: invalid });
      return;
    }
    setBusyId(id);
    try {
      const { location } = await apiFetch<{ location: LocationRow }>(`/api/account/locations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { name: editing.name },
      });
      setData((d) => (d ? { ...d, locations: d.locations.map((l) => (l.id === id ? { ...l, name: location.name } : l)) } : d));
      setEditing(null);
      toast.success("Location renamed");
      focusRow(id, "rename");
      router.refresh();
    } catch (error) {
      setEditing((e) => (e ? { ...e, error: fieldMessage(error) } : e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (location: LocationRow) => {
    if (busyId) return;
    setBusyId(location.id);
    try {
      const result = await apiFetch<{ devicesMoved: number }>(`/api/account/locations/${encodeURIComponent(location.id)}`, {
        method: "DELETE",
      });
      setData((d) =>
        d
          ? {
              locations: d.locations.filter((l) => l.id !== location.id),
              unassignedDevices: d.unassignedDevices + location.activeDevices,
            }
          : d,
      );
      setDeleting(null);
      const moved = result.devicesMoved;
      toast.success(moved > 0 ? `${location.name} deleted · ${moved} ${moved === 1 ? "device" : "devices"} moved to Unassigned` : `${location.name} deleted`);
      addRef.current?.focus();
      router.refresh();
    } catch (error) {
      setDeleting({ id: location.id, error: errorMessage(error) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="grid gap-4">
      <div>
        <DialogTitle className="m-0 text-[18px] font-extrabold leading-[normal] tracking-normal">Manage locations</DialogTitle>
        <DialogDescription className="mb-0 mt-2 text-[14.5px] leading-[1.6] text-ink-2">
          Group computers by shop or branch. Deleting a location moves its devices to Unassigned.
        </DialogDescription>
      </div>

      <form onSubmit={add} noValidate className="grid gap-1.5">
        <label htmlFor={addId} className="text-[13.5px] font-bold">
          New location
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            ref={addRef}
            id={addId}
            type="text"
            value={newName}
            maxLength={LOCATION_NAME_MAX + 20}
            placeholder="e.g. Kothrud branch"
            autoComplete="off"
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? `${addId}-error` : undefined}
            onChange={(event) => {
              setNewName(event.target.value);
              if (addError) setAddError(null);
            }}
            className={cn(DIALOG_INPUT, "min-w-0 flex-[1_1_200px]")}
          />
          <Button type="submit" className="h-[42px] rounded-10 px-4 text-[14px]" loading={adding}>
            <Icon name="add" size={18} />
            Add
          </Button>
        </div>
        {addError ? (
          <p id={`${addId}-error`} className="m-0 text-[13px] font-semibold text-danger">
            {addError}
          </p>
        ) : null}
      </form>

      <div
        className="max-h-[min(360px,50dvh)] overflow-y-auto rounded-12 border border-line-alt"
        aria-busy={!data && !loadError ? true : undefined}
      >
        {loadError ? (
          <div role="alert" className="grid justify-items-start gap-2 p-4 text-[14px] text-ink-2">
            {loadError}
            <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : !data ? (
          <div className="grid gap-2 p-3">
            <span className="sr-only" role="status">
              Loading locations
            </span>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} alt className="h-10 rounded-10" />
            ))}
          </div>
        ) : (
          <ul ref={listRef} aria-label="Locations" className="m-0 list-none divide-y divide-line-subtle p-0">
            {data.locations.length === 0 ? (
              <li className="px-3.5 py-3 text-[14px] text-ink-2">No locations yet. Add your first shop or branch above.</li>
            ) : null}
            {data.locations.map((location) => (
              <LocationItem
                key={location.id}
                location={location}
                editing={editing?.id === location.id ? editing : null}
                deleting={deleting?.id === location.id ? deleting : null}
                busy={busyId === location.id}
                setEditing={setEditing}
                setDeleting={setDeleting}
                onSave={() => void saveRename(location.id)}
                onDelete={() => void remove(location)}
                focusRow={focusRow}
              />
            ))}
            <li className="flex items-center gap-2 bg-bg px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-extrabold text-ink-2">Unassigned</div>
                <div className="text-[12.5px] font-semibold text-ink-2">{devicesText(data.unassignedDevices)}</div>
              </div>
            </li>
          </ul>
        )}
      </div>

      <div className="flex justify-end">
        <Button type="button" variant="secondary" className="rounded-10 px-4 py-2.5 text-[16px] leading-[normal]" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

type EditState = { id: string; name: string; error: string | null };
type DeleteState = { id: string; error: string | null };

function LocationItem({
  location,
  editing,
  deleting,
  busy,
  setEditing,
  setDeleting,
  onSave,
  onDelete,
  focusRow,
}: {
  location: LocationRow;
  editing: EditState | null;
  deleting: DeleteState | null;
  busy: boolean;
  setEditing: (state: EditState | null) => void;
  setDeleting: (state: DeleteState | null) => void;
  onSave: () => void;
  onDelete: () => void;
  focusRow: (id: string, action: "rename" | "delete") => void;
}) {
  const cancelEdit = () => {
    setEditing(null);
    focusRow(location.id, "rename");
  };
  return (
    <li data-location={location.id} className="grid gap-2 px-3.5 py-2.5">
      {editing ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
          className="grid gap-1.5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              aria-label={`New name for ${location.name}`}
              value={editing.name}
              maxLength={LOCATION_NAME_MAX + 20}
              // The field replaces the Rename button the member just pressed.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              aria-invalid={editing.error ? true : undefined}
              onChange={(event) => setEditing({ ...editing, name: event.target.value, error: null })}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                // Escape cancels the rename, not the whole dialog.
                event.preventDefault();
                event.stopPropagation();
                cancelEdit();
              }}
              className={cn(DIALOG_INPUT, "h-9 min-w-0 flex-[1_1_180px]")}
            />
            <Button type="submit" size="sm" className={ROW_BUTTON} loading={busy}>
              Save
            </Button>
            <Button type="button" variant="secondary" size="sm" className={ROW_BUTTON} onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
          {editing.error ? (
            <p role="alert" className="m-0 text-[13px] font-semibold text-danger">
              {editing.error}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-extrabold">{location.name}</div>
            <div className="text-[12.5px] font-semibold text-ink-2">{devicesText(location.activeDevices)}</div>
          </div>
          <button
            type="button"
            data-action="rename"
            aria-label={`Rename ${location.name}`}
            className={ICON_BUTTON}
            onClick={() => {
              setDeleting(null);
              setEditing({ id: location.id, name: location.name, error: null });
            }}
          >
            <Icon name="border_color" size={18} />
          </button>
          <button
            type="button"
            data-action="delete"
            aria-label={`Delete ${location.name}`}
            className={cn(ICON_BUTTON, "hover:bg-pink-bg hover:text-danger")}
            onClick={() => {
              setEditing(null);
              setDeleting({ id: location.id, error: null });
            }}
          >
            <Icon name="delete" size={18} />
          </button>
        </div>
      )}
      {deleting ? (
        <div role="group" aria-label={`Delete ${location.name}`} className="grid gap-2 rounded-10 bg-pink-soft p-3">
          <p className="m-0 text-[13.5px] font-semibold text-ink">
            Delete “{location.name}”?{" "}
            {location.activeDevices > 0
              ? `${location.activeDevices === 1 ? "Its device moves" : `Its ${location.activeDevices} devices move`} to Unassigned.`
              : "No active devices use it."}
          </p>
          {deleting.error ? (
            <p role="alert" className="m-0 text-[13px] font-bold text-danger">
              {deleting.error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" size="sm" className={ROW_BUTTON} loading={busy} onClick={onDelete}>
              Delete
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={ROW_BUTTON}
              onClick={() => {
                setDeleting(null);
                focusRow(location.id, "delete");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
