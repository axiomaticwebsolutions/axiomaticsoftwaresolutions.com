"use client";

import * as React from "react";
import { fitHeight, logoFor, type BrandImage, type EffectiveBranding } from "@/lib/branding/model";
import { SITE_NAME } from "@/lib/seo/metadata";
import { cn } from "@/lib/utils";

/** Uploaded logos (Admin > Settings > Branding); null per background = the built-in logo. */
export type ClientBranding = Pick<EffectiveBranding, "logoLight" | "logoDark">;

const BrandingContext = React.createContext<ClientBranding | null>(null);

/**
 * Hands the uploaded logos to every logo on the page (root layout, from lib/branding/server.ts getBranding). Without
 * it (tests, isolated renders) every logo is the built-in one.
 */
export function BrandingProvider({ value, children }: { value: ClientBranding; children: React.ReactNode }) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

/** The uploaded logo for this background, or null for the built-in one. */
export function useBrandLogo(onDark = false): BrandImage | null {
  const branding = React.useContext(BrandingContext);
  return branding ? logoFor({ ...branding, favicon: null }, onDark) : null;
}

export type UploadedLogoProps = {
  image: BrandImage;
  /** Display height in px (the built-in mark's size: 34 in headers and footers, 30-36 elsewhere). */
  height: number;
  /** A wide logo is capped here and gets shorter instead. */
  maxWidth: number;
  className?: string;
};

/**
 * An uploaded logo: width and height set from its stored size scaled to `height` (no layout shift while it loads),
 * shrinking with its container on narrow screens. Alt text is the brand name (SITE_NAME, also the built-in logo’s
 * accessible name); a wrapping link’s aria-label still wins.
 */
export function UploadedLogo({ image, height, maxWidth, className }: UploadedLogoProps) {
  const size = fitHeight(image, height, maxWidth);
  return (
    // A plain <img>: the file is already small and versioned (cached for a year); next/image would add a resize hop.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image.src}
      alt={SITE_NAME}
      width={size.width}
      height={size.height}
      decoding="async"
      data-slot="logo"
      className={cn("block h-auto max-w-full shrink-0", className)}
    />
  );
}

/**
 * The uploaded logo for this background when there is one, else `children` (the built-in lockup). Lets server
 * components keep their built-in markup and still show an upload.
 */
export function BrandLogoSwap({
  onDark = false,
  height,
  maxWidth,
  className,
  children,
}: {
  onDark?: boolean;
  height: number;
  maxWidth: number;
  className?: string;
  children: React.ReactNode;
}) {
  const image = useBrandLogo(onDark);
  return image ? <UploadedLogo image={image} height={height} maxWidth={maxWidth} className={className} /> : <>{children}</>;
}
