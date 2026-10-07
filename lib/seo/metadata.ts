/**
 * Per-page metadata: absolute canonical URL, OpenGraph and Twitter cards, optional noindex.
 * URLs are built from APP_URL (the same origin as the root layout's metadataBase).
 */
import type { Metadata } from "next";

export const SITE_NAME = "Axiomatic Software Solutions";
export const SITE_TAGLINE = "Smart software for everyday business.";
export const SITE_LOCALE = "en_IN";

/** app/opengraph-image.tsx */
export const OG_IMAGE_PATH = "/opengraph-image";
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const OG_IMAGE_ALT = `${SITE_NAME}: ${SITE_TAGLINE}`;

/** Private areas kept out of search engines (app/robots.ts). */
export const ROBOTS_DISALLOW = ["/account", "/admin", "/api", "/dev", "/cart", "/checkout", "/orders", "/compare", "/invite", "/staff-invite"] as const;

const DEV_ORIGIN = "http://localhost:3000";

/** The site origin from APP_URL, without a trailing slash (http://localhost:3000 when unset in development). */
export function siteOrigin(): string {
  const raw = process.env.APP_URL?.trim();
  return (raw ? raw : DEV_ORIGIN).replace(/\/+$/, "");
}

/** Absolute URL for a site path ("/software" -> "https://example.com/software"). Absolute URLs pass through. */
export function siteUrl(path = "/"): string {
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path.startsWith("/") ? path : `/${path}`, `${siteOrigin()}/`).toString();
}

export type OgImageInput = { url: string; width?: number; height?: number; alt?: string };

export type BuildMetadataInput = {
  /** Page title; the root layout title template adds the site name unless `absoluteTitle` is set. */
  title: string;
  description: string;
  /** Canonical path, e.g. "/software" (filtered catalog URLs use "/software"). */
  path: string;
  /** Keep the page out of search results (links are still followed). */
  noindex?: boolean;
  /** Use the title as is (the home page). */
  absoluteTitle?: boolean;
  /**
   * Share images. Default: the site image (app/opengraph-image.tsx). "segment" leaves them out so an
   * opengraph-image file in the page's own route segment supplies them (Next only applies file images when the
   * page metadata sets none).
   */
  images?: readonly OgImageInput[] | "segment";
};

function defaultImages(): OgImageInput[] {
  return [{ url: OG_IMAGE_PATH, ...OG_IMAGE_SIZE, alt: OG_IMAGE_ALT }];
}

export function buildMetadata(input: BuildMetadataInput): Metadata {
  const url = siteUrl(input.path);
  const images =
    input.images === "segment"
      ? undefined
      : (input.images ?? defaultImages()).map((image) => ({ ...image, url: siteUrl(image.url) }));
  const shared = { title: input.title, description: input.description, ...(images ? { images } : {}) };
  return {
    title: input.absoluteTitle ? { absolute: input.title } : input.title,
    description: input.description,
    alternates: { canonical: url },
    openGraph: { type: "website", siteName: SITE_NAME, locale: SITE_LOCALE, url, ...shared },
    twitter: { card: "summary_large_image", ...shared },
    ...(input.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}
