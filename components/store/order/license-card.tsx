import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { PRODUCT_TONES } from "@/components/store/product/tones";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DownloadReleaseView } from "@/lib/downloads/model";
import { LICENSE_STATUS_META } from "@/lib/licensing/status";
import type { OrderStatusLicense } from "@/lib/orders/status";
import { cn } from "@/lib/utils";
import {
  licenseKeyDomId,
  licenseKeyStripDomId,
  licenseLimitLabel,
  licenseTermLabel,
  type OrderProductMeta,
  type OrderViewer,
} from "./order-model";
import { LicenseDownloads } from "./license-downloads";

export type RevealedKey = { key: string; secondsLeft: number };

export type LicenseCardProps = {
  license: OrderStatusLicense;
  product: OrderProductMeta | undefined;
  perUnit: string | null;
  /** The full key while it is on screen (delivered once by the status API). */
  revealed: RevealedKey | null;
  copied: boolean;
  onCopy: () => void;
  onHide: () => void;
  viewer: OrderViewer;
  canClaim: boolean;
  downloadLinkMinutes: number;
  /** Published releases of the product, newest first (the download row offers the one this license may download). */
  releases: readonly DownloadReleaseView[];
  orderId: string;
  /** Order link token (guests), or null. */
  token: string | null;
};

/** Portal pages (Phase 5) where keys are revealed with the password and installers are downloaded. */
export const ACCOUNT_LICENSES_PATH = "/account/licenses";
export const ACCOUNT_SOFTWARE_PATH = "/account/software";

const SMALL_BUTTON = "rounded-10 px-3 py-2 text-[13.5px] leading-[normal]";
const NOTE = "text-[13.5px] font-semibold text-ink-2";

function maskedNote(viewer: OrderViewer, canClaim: boolean): string {
  const lead = "For your security, the full key is shown only once.";
  if (viewer.member) return viewer.canReveal ? `${lead} Reveal it from your account.` : `${lead} Your account owner or technical contact can reveal it.`;
  return `${lead} Reveal it from your account: ${canClaim ? "create one" : "sign in"} with this order’s email.`;
}

function shownOnceNote(viewer: OrderViewer, seconds: number): string {
  const later = viewer.member
    ? viewer.canReveal
      ? "; you can reveal it later in your account"
      : ""
    : "; later you can reveal it from an account with this order’s email";
  return ` It hides in ${seconds} s and won’t appear on this page again${later}.`;
}

/** One issued license (Order.dc.html "Your licenses"): product, terms, status, key strip and download row. */
export function LicenseCard(props: LicenseCardProps) {
  const { license, product, perUnit, revealed, viewer } = props;
  const meta = LICENSE_STATUS_META[license.status];
  const tone = PRODUCT_TONES[product?.tone ?? "lavender"];
  return (
    <div className="rounded-22 border border-line bg-surface p-6 print:break-inside-avoid">
      <div className="flex flex-wrap items-center gap-3.5">
        <span aria-hidden="true" className={cn("grid size-[46px] place-items-center rounded-14", tone.tile)}>
          <Icon name={product?.icon ?? "receipt_long"} size={24} />
        </span>
        <div className="min-w-0 flex-[1_1_220px]">
          <h3 className="text-[17px] font-extrabold">{license.productName}</h3>
          <div className="text-sm font-semibold text-ink-2">
            {license.planName} · {licenseLimitLabel(license.deviceLimit, perUnit)} · {licenseTermLabel(license)}
          </div>
        </div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>

      <div
        id={licenseKeyStripDomId(license.id)}
        className="mt-[18px] flex flex-wrap items-center gap-2.5 rounded-14 border border-line-subtle bg-bg px-4 py-3.5"
      >
        <span className="text-xs font-extrabold tracking-[0.08em] text-ink-2">LICENSE KEY</span>
        {/* Focus target when the key is hidden (OrderView): its Hide and Copy key buttons unmount with it. */}
        <code
          id={licenseKeyDomId(license.id)}
          tabIndex={-1}
          className="min-w-0 flex-[1_1_240px] rounded-6 font-mono text-[15.5px] font-medium tracking-[0.04em] [overflow-wrap:anywhere]"
        >
          {revealed ? (
            <>
              <span className="print:hidden">{revealed.key}</span>
              <span className="hidden print:inline">{license.keyMasked}</span>
            </>
          ) : (
            license.keyMasked
          )}
        </code>
        {revealed ? (
          <>
            <Button type="button" variant="secondary" size="sm" className={cn(SMALL_BUTTON, "print:hidden")} onClick={props.onHide}>
              Hide
            </Button>
            <Button type="button" size="sm" className={cn(SMALL_BUTTON, "print:hidden")} onClick={props.onCopy}>
              {props.copied ? "Copied" : "Copy key"}
            </Button>
          </>
        ) : meta.usable && viewer.member && viewer.canReveal ? (
          <Button asChild variant="secondary" size="sm" className={cn(SMALL_BUTTON, "print:hidden")}>
            <Link href={ACCOUNT_LICENSES_PATH}>Reveal in account</Link>
          </Button>
        ) : null}
      </div>

      {revealed ? (
        <p className="mt-3 flex items-start gap-2 rounded-12 bg-peach-bg px-3.5 py-2.5 text-[13.5px] font-semibold text-notice-ink print:hidden">
          <Icon name="key" size={18} className="mt-px text-peach-fg" />
          <span>
            <strong className="font-extrabold">Shown once — save it now.</strong>
            {shownOnceNote(viewer, revealed.secondsLeft)}
          </span>
        </p>
      ) : meta.usable ? (
        <p className={cn("mt-2.5 print:hidden", NOTE)}>{maskedNote(viewer, props.canClaim)}</p>
      ) : null}

      {meta.usable ? (
        <LicenseDownloads
          license={license}
          releases={props.releases}
          orderId={props.orderId}
          token={props.token}
          viewer={viewer}
          downloadLinkMinutes={props.downloadLinkMinutes}
        />
      ) : null}
    </div>
  );
}

