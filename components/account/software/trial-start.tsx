"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { DisabledAction } from "@/components/account/disabled-action";
import { usePortal } from "@/components/account/portal-context";
import { licensePath } from "@/components/account/portal-nav";
import { CALLOUT_CTA_CLASS, PortalCallout } from "@/components/account/overview/callout";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import {
  CATALOG_PATH,
  productPageHref,
  TRIAL_COPY,
  trialTerms,
  trialUpgradeHref,
  TRIALS_API_PATH,
  type StartedTrialBody,
  type TrialOffer,
} from "./model";

/** "offer" renders the current offer from the server (props), so a refresh after a 409 shows the updated notice. */
type Phase = { kind: "offer" } | { kind: "started"; started: StartedTrialBody } | { kind: "hidden" };

const DISMISS_CLASS =
  "grid size-8 cursor-pointer place-items-center rounded-8 border-0 bg-transparent text-ink-2 transition-colors hover:bg-surface hover:text-ink";
const DIALOG_CANCEL =
  "cursor-pointer rounded-10 border border-line-input bg-surface px-4 py-2.5 text-[16px] font-bold leading-[normal] text-ink transition-colors hover:border-primary";
const DIALOG_CONFIRM =
  "inline-flex cursor-pointer items-center gap-2 rounded-10 border-0 bg-primary px-4 py-2.5 text-[16px] font-bold leading-[normal] text-white transition-colors hover:bg-primary-hover aria-busy:cursor-progress";

/** Drops ?trial= from the address bar without a navigation (Next keeps its router state in sync). */
function stripTrialParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("trial")) return;
  url.searchParams.delete("trial");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * /account/software?trial=<slug> (the storefront's "Start free trial" lands here, through register and verify when
 * needed): a notice for the requested trial with "Start free trial", which opens a confirmation dialog (opened once
 * on arrival for members who may start trials), then POST /api/account/trials and the new trial license with a link
 * to it. Already running, already used, unavailable and unknown products get their own notice. Members without
 * `trials.start` (Viewer) see the action disabled. The list below refreshes from the server after a start.
 */
export function TrialStart({ offer }: { offer: TrialOffer | null }) {
  const { can, account } = usePortal();
  const router = useRouter();
  const mayStart = can("trials.start");
  const [phase, setPhase] = React.useState<Phase>({ kind: "offer" });
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const startedRef = React.useRef<HTMLDivElement>(null);
  const startButtonRef = React.useRef<HTMLButtonElement>(null);
  const autoOpened = React.useRef(false);

  // Open the confirmation once on arrival: the visitor already chose "Start free trial" on the product page.
  React.useEffect(() => {
    if (autoOpened.current || phase.kind !== "offer" || offer?.state !== "ready" || !mayStart) return;
    autoOpened.current = true;
    setOpen(true);
  }, [phase.kind, offer?.state, mayStart]);

  React.useEffect(() => {
    if (phase.kind === "started") startedRef.current?.focus();
  }, [phase.kind]);

  if (phase.kind === "hidden" || (phase.kind === "offer" && !offer)) return null;

  function dismiss() {
    stripTrialParam();
    setPhase({ kind: "hidden" });
  }

  async function start(productId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await apiFetch<StartedTrialBody>(TRIALS_API_PATH, { body: { productId } });
      setOpen(false);
      setPhase({ kind: "started", started });
      toast.success(TRIAL_COPY.startedToast(started.license.id));
      stripTrialParam();
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "trial_used") {
        // Started meanwhile (another tab or team member): the refreshed offer shows the running or used trial.
        setOpen(false);
        router.refresh();
        return;
      }
      setError(e instanceof ApiClientError ? e.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  const dismissButton = (
    <button type="button" onClick={dismiss} aria-label={TRIAL_COPY.dismiss} title={TRIAL_COPY.dismiss} className={DISMISS_CLASS}>
      <Icon name="close" size={18} />
    </button>
  );

  if (phase.kind === "started") {
    const { license, href } = phase.started;
    return (
      <PortalCallout
        ref={startedRef}
        tabIndex={-1}
        className="outline-none"
        tone="sage"
        icon="check_circle"
        title={TRIAL_COPY.startedTitle(license.productShortName)}
        body={TRIAL_COPY.startedBody(license.id, license.expiresAt)}
        actions={
          <>
            <Link href={href.startsWith("/account/") ? href : licensePath(license.id)} className={CALLOUT_CTA_CLASS}>
              {TRIAL_COPY.viewLicense}
            </Link>
            {dismissButton}
          </>
        }
      />
    );
  }

  if (!offer) return null;

  switch (offer.state) {
    case "ready": {
      const terms = trialTerms(offer);
      const startButton = (
        <button
          ref={startButtonRef}
          type="button"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          className={CALLOUT_CTA_CLASS}
        >
          {TRIAL_COPY.startCta}
        </button>
      );
      return (
        <>
          <PortalCallout
            tone="blue"
            icon="timer"
            title={TRIAL_COPY.readyTitle(offer.product.shortName)}
            body={TRIAL_COPY.readyBody(terms)}
            actions={
              <>
                {mayStart ? (
                  startButton
                ) : (
                  <DisabledAction perm="trials.start" asChild>
                    <button type="button" className={CALLOUT_CTA_CLASS}>
                      {TRIAL_COPY.startCta}
                    </button>
                  </DisabledAction>
                )}
                {dismissButton}
              </>
            }
          />
          <Dialog
            open={open}
            onOpenChange={(next) => {
              if (busy) return;
              setOpen(next);
              if (!next) setError(null);
            }}
          >
            <DialogContent
              showClose={false}
              className="max-w-[460px] gap-0 rounded-18 p-[22px] leading-[normal] sm:p-[22px]"
              onCloseAutoFocus={(event) => {
                // After "Cancel" on the dialog opened on arrival, focus the notice's own button (not <body>).
                if (startButtonRef.current?.isConnected) {
                  event.preventDefault();
                  startButtonRef.current.focus();
                }
              }}
            >
              <DialogTitle>{TRIAL_COPY.dialogTitle(offer.product.shortName)}</DialogTitle>
              <DialogDescription className="mt-2 leading-[1.6]">
                {TRIAL_COPY.dialogBody(offer.product.name, terms, account.legalName)}
              </DialogDescription>
              {error ? (
                <div role="alert" className="mt-3 rounded-10 bg-pink-bg px-3 py-2.5 text-[13.5px] font-bold text-danger">
                  {error}
                </div>
              ) : null}
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button type="button" className={DIALOG_CANCEL} onClick={() => !busy && setOpen(false)}>
                  {TRIAL_COPY.cancel}
                </button>
                <button
                  type="button"
                  className={DIALOG_CONFIRM}
                  aria-busy={busy || undefined}
                  onClick={() => void start(offer.product.id)}
                >
                  {busy ? <Spinner tone="onPrimary" size="sm" /> : null}
                  {TRIAL_COPY.startCta}
                </button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    case "active":
      return (
        <PortalCallout
          tone="blue"
          icon="timer"
          title={TRIAL_COPY.activeTitle(offer.product.shortName)}
          body={TRIAL_COPY.activeBody(offer.licenseId, offer.expiresAt)}
          actions={
            <>
              <Link href={licensePath(offer.licenseId)} className={CALLOUT_CTA_CLASS}>
                {TRIAL_COPY.viewLicense}
              </Link>
              {dismissButton}
            </>
          }
        />
      );
    case "used":
      return (
        <PortalCallout
          tone="peach"
          icon="event_busy"
          title={TRIAL_COPY.usedTitle}
          body={
            offer.licenseIsTrial
              ? TRIAL_COPY.usedTrialBody(offer.licenseId, offer.expiresAt)
              : TRIAL_COPY.usedPaidBody(offer.licenseId)
          }
          actions={
            <>
              {!offer.licenseIsTrial ? (
                <Link href={licensePath(offer.licenseId)} className={CALLOUT_CTA_CLASS}>
                  {TRIAL_COPY.viewLicense}
                </Link>
              ) : can("purchases") ? (
                <Link href={trialUpgradeHref(offer.licenseId)} className={CALLOUT_CTA_CLASS}>
                  {TRIAL_COPY.buyLicense}
                </Link>
              ) : (
                <DisabledAction perm="purchases" asChild>
                  <button type="button" className={CALLOUT_CTA_CLASS}>
                    {TRIAL_COPY.buyLicense}
                  </button>
                </DisabledAction>
              )}
              {dismissButton}
            </>
          }
        />
      );
    case "owned":
      return (
        <PortalCallout
          tone="sage"
          icon="verified"
          title={TRIAL_COPY.ownedTitle(offer.product.shortName)}
          body={TRIAL_COPY.ownedBody(offer.licenseId, offer.planName)}
          actions={
            <>
              <Link href={licensePath(offer.licenseId)} className={CALLOUT_CTA_CLASS}>
                {TRIAL_COPY.viewLicense}
              </Link>
              {dismissButton}
            </>
          }
        />
      );
    case "unavailable":
      return (
        <PortalCallout
          tone="lavender"
          icon="info"
          title={TRIAL_COPY.unavailableTitle}
          body={TRIAL_COPY.unavailableBody(offer.product.shortName)}
          actions={
            <>
              <Link href={productPageHref(offer.slug)} className={CALLOUT_CTA_CLASS}>
                {TRIAL_COPY.viewProduct}
              </Link>
              {dismissButton}
            </>
          }
        />
      );
    case "not_found":
      return (
        <PortalCallout
          tone="pink"
          icon="search_off"
          title={TRIAL_COPY.notFoundTitle}
          body={TRIAL_COPY.notFoundBody}
          actions={
            <>
              <Link href={CATALOG_PATH} className={CALLOUT_CTA_CLASS}>
                {TRIAL_COPY.browse}
              </Link>
              {dismissButton}
            </>
          }
        />
      );
    default:
      return null;
  }
}
