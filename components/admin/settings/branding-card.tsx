"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { useAdminOptional } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { BuiltInLogo, LogoMark } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import {
  BRAND_SLOTS,
  BRANDING_COPY,
  brandFilePath,
  clientFileProblem,
  describeAsset,
  fitHeight,
  type BrandAssetInfo,
  type BrandingState,
  type BrandSlot,
} from "@/lib/branding/model";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { READ_ONLY_FOR_ROLE } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { SETTINGS_GRID_CLASS, SettingsCard } from "./settings-card";

type WriteResponse = { slot: BrandSlot; changed: boolean; branding: BrandingState };

/** Preview sizes: logos as on the site (34 px tall), the favicon large enough to judge (48 px). */
const PREVIEW_LOGO_HEIGHT = 34;
const PREVIEW_LOGO_MAX_WIDTH = 200;
const PREVIEW_ICON_SIZE = 48;

/** The current file (or the built-in look) on a swatch of its background. */
function Preview({ slot, asset }: { slot: BrandSlot; asset: BrandAssetInfo | null }) {
  const copy = BRANDING_COPY.slots[slot];
  if (!asset) {
    if (slot === "favicon") return <LogoMark size={PREVIEW_ICON_SIZE} />;
    return <BuiltInLogo onDark={copy.dark} />;
  }
  const size =
    slot === "favicon"
      ? { width: PREVIEW_ICON_SIZE, height: PREVIEW_ICON_SIZE }
      : fitHeight(asset, PREVIEW_LOGO_HEIGHT, PREVIEW_LOGO_MAX_WIDTH);
  return (
    // The stored file itself (versioned URL); next/image would only add a resize hop.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={brandFilePath(slot, asset.version)}
      alt={BRANDING_COPY.preview(copy.title)}
      width={size.width}
      height={size.height}
      className="block h-auto max-w-full object-contain"
    />
  );
}

function SlotPanel({
  slot,
  asset,
  locked,
  onChange,
}: {
  slot: BrandSlot;
  asset: BrandAssetInfo | null;
  locked: boolean;
  onChange: (next: BrandingState) => void;
}) {
  const copy = BRANDING_COPY.slots[slot];
  const uid = React.useId();
  const ids = { title: `${uid}-title`, meta: `${uid}-meta`, hint: `${uid}-hint`, error: `${uid}-error` };
  const inputRef = React.useRef<HTMLInputElement>(null);
  const uploadRef = React.useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  // After a removal the Remove button is gone: focus goes to Upload instead of the document.
  const focusUploadOnClose = React.useRef(false);

  const focusUpload = () => window.requestAnimationFrame(() => uploadRef.current?.focus());

  async function upload(file: File) {
    if (busy || locked) return;
    const problem = clientFileProblem(slot, file);
    if (problem) {
      setError(problem);
      focusUpload();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch<WriteResponse>(`/api/admin/settings/branding/${slot}`, { method: "PUT", file });
      onChange(res.branding);
      adminToast.success(BRANDING_COPY.toasts.uploaded(copy.title));
    } catch (cause) {
      const fieldError = cause instanceof ApiClientError ? cause.fieldErrors.file?.[0] : undefined;
      if (fieldError) {
        setError(fieldError);
        focusUpload();
      } else {
        adminToast.error(cause);
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The dialog renders in a portal, but React events still bubble: never submit anything around the card.
    event.stopPropagation();
    if (removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await apiFetch<WriteResponse>(`/api/admin/settings/branding/${slot}`, { method: "DELETE", body: {} });
      onChange(res.branding);
      setError(null);
      adminToast.success(BRANDING_COPY.toasts.removed(copy.title));
      focusUploadOnClose.current = true;
      setConfirmOpen(false);
    } catch (cause) {
      setRemoveError(cause instanceof Error && cause.message ? cause.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setRemoving(false);
    }
  }

  const describedBy = [error ? ids.error : null, ids.meta, ids.hint].filter(Boolean).join(" ");
  const canDrop = !locked && !busy;

  return (
    <div role="group" aria-labelledby={ids.title} className="grid min-w-0 content-start gap-2">
      <h3 id={ids.title} className="m-0 text-[12.5px] font-bold">
        {copy.title}
      </h3>
      {/* Drag and drop is a shortcut for pointer users; the Upload button does the same from the keyboard. */}
      <div
        className={cn(
          "grid h-[84px] min-w-0 place-items-center overflow-hidden rounded-10 border px-3 transition-colors",
          copy.dark ? "border-ink bg-ink" : "border-line bg-surface",
          dragging && "outline-2 outline-offset-2 outline-primary outline-dashed",
        )}
        // A dragged file is always taken over here (preventDefault), even while an upload runs: otherwise the
        // browser would open the dropped file and leave this page. It is only uploaded when the slot can take it.
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = canDrop ? "copy" : "none";
          setDragging(canDrop);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!canDrop) return;
          const file = event.dataTransfer.files[0];
          if (file) void upload(file);
        }}
      >
        <Preview slot={slot} asset={asset} />
      </div>
      <p id={ids.meta} className="m-0 text-[12px] font-semibold text-ink-2">
        {asset ? describeAsset(asset) : copy.builtIn}
      </p>
      {error ? (
        // role="alert": announced even when focus cannot move (after the file picker, focus is already on Upload).
        <FieldError id={ids.error} role="alert" className="text-[12.5px]">
          {error}
        </FieldError>
      ) : null}
      <p id={ids.hint} className="m-0 text-[12px] text-ink-2">
        {copy.hint}
        {locked ? null : <span className="hidden pointer-fine:inline"> {BRANDING_COPY.dropHint}</span>}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={uploadRef}
          type="button"
          size="sm"
          variant="secondary"
          className="px-3 py-[7px] text-[13px]"
          disabled={locked}
          loading={busy}
          aria-describedby={describedBy}
          onClick={() => inputRef.current?.click()}
        >
          <Icon name="upload" size={17} />
          {asset ? BRANDING_COPY.replace : BRANDING_COPY.upload}
          <span className="sr-only">: {copy.title}</span>
        </Button>
        {asset ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="px-3 py-[7px] text-[13px] text-danger hover:bg-pink-bg hover:text-danger"
            disabled={locked || busy}
            onClick={() => {
              setRemoveError(null);
              setConfirmOpen(true);
            }}
          >
            {BRANDING_COPY.remove}
            <span className="sr-only">: {copy.title}</span>
          </Button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept={copy.accept}
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!removing) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            if (!focusUploadOnClose.current) return;
            focusUploadOnClose.current = false;
            event.preventDefault();
            uploadRef.current?.focus();
          }}
        >
          <form onSubmit={remove} className="grid gap-4" noValidate>
            <div className="flex gap-3">
              <span aria-hidden="true" className="grid size-[38px] shrink-0 place-items-center rounded-10 bg-pink-bg text-pink-fg">
                <Icon name="delete" size={21} />
              </span>
              <div className="grid min-w-0 gap-1.5">
                <AlertDialogTitle>{BRANDING_COPY.removeTitle(copy.title)}</AlertDialogTitle>
                <AlertDialogDescription>{BRANDING_COPY.removeBody}</AlertDialogDescription>
              </div>
            </div>
            {removeError ? (
              <div role="alert" className="rounded-8 bg-pink-bg px-2.5 py-2 text-[13px] font-bold text-danger">
                {removeError}
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
              <Button type="submit" size="sm" variant="destructive" loading={removing}>
                {BRANDING_COPY.remove}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Admin > Settings > Branding (docs/decisions.md "Branding: logos and favicon"): the logo for light backgrounds, the
 * logo for dark backgrounds and the favicon. Each slot shows the current file (or the built-in look) on a swatch of
 * its background with its type, size and pixel dimensions, short guidance, Upload / Replace (file picker, or drop a
 * file on the swatch) and Remove (back to the built-in look, after a confirmation). The server checks every file
 * (PUT /api/admin/settings/branding/:slot); its message shows under the slot and focus returns to the Upload button,
 * which the message describes. Uploads apply at once (the page refreshes; the storefront cache is revalidated).
 * Owner only (settings.manage); read only for anyone else who could see it.
 */
export function BrandingCard({ initial }: { initial: BrandingState }) {
  const router = useRouter();
  const admin = useAdminOptional();
  const locked = !!admin && !admin.can("settings.manage");
  const [state, setState] = React.useState<BrandingState>(initial);

  const onChange = (next: BrandingState) => {
    setState(next);
    // Server components (the admin sidebar logo, this page) pick up the new files.
    router.refresh();
  };

  return (
    <SettingsCard
      id="settings-branding"
      icon={BRANDING_COPY.icon}
      title={BRANDING_COPY.title}
      description={BRANDING_COPY.description}
      note={locked ? READ_ONLY_FOR_ROLE : BRANDING_COPY.note}
    >
      <div className={SETTINGS_GRID_CLASS}>
        {BRAND_SLOTS.map((slot) => (
          <SlotPanel key={slot} slot={slot} asset={state[slot]} locked={locked} onChange={onChange} />
        ))}
      </div>
    </SettingsCard>
  );
}
