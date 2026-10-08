/**
 * Branding (Admin > Settings > Branding; docs/decisions.md "Branding: logos and favicon"): the three upload slots,
 * their rules and copy, the versioned file URLs (GET /brand/:file) and the "effective branding" every surface reads.
 * Pure and client-safe: no bytes, no database, no sharp.
 *
 * Slots: the logo for LIGHT backgrounds (storefront, auth pages, portal, admin, order pages, invoices and emails), the
 * logo for DARK backgrounds (dark surfaces: components/brand/logo.tsx `onDark`, emails opened in dark mode) and the
 * favicon. Each slot falls back on its own to the built-in look (LogoMark + wordmark, app/icon.svg).
 *
 * URLs carry a content version, `?v=` + the first 12 hex characters of the stored file's SHA-256: a matching version
 * is cached for a year (immutable), so a new upload changes every URL that points at it.
 */
import type { IconName } from "@/components/icons/icon";

export const BRAND_SLOTS = ["logo-light", "logo-dark", "favicon"] as const;
export type BrandSlot = (typeof BRAND_SLOTS)[number];

export function isBrandSlot(value: unknown): value is BrandSlot {
  return typeof value === "string" && (BRAND_SLOTS as readonly string[]).includes(value);
}

/** Prisma enum value of each slot (BrandAsset.slot). */
export const BRAND_SLOT_DB = { "logo-light": "LOGO_LIGHT", "logo-dark": "LOGO_DARK", favicon: "FAVICON" } as const;
export type BrandSlotDb = (typeof BRAND_SLOT_DB)[BrandSlot];

export function slotFromDb(value: string): BrandSlot | null {
  const found = BRAND_SLOTS.find((slot) => BRAND_SLOT_DB[slot] === value);
  return found ?? null;
}

/** Formats the site stores and serves. */
export const BRAND_FORMATS = ["png", "webp", "svg", "ico"] as const;
export type BrandFormat = (typeof BRAND_FORMATS)[number];

export const BRAND_MIME: Record<BrandFormat, string> = {
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

export const BRAND_FORMAT_LABEL: Record<BrandFormat, string> = { png: "PNG", webp: "WebP", svg: "SVG", ico: "ICO" };

export function formatFromMime(mime: string): BrandFormat | null {
  const found = BRAND_FORMATS.find((f) => BRAND_MIME[f] === mime);
  return found ?? null;
}

const KB = 1024;
const MB = 1024 * KB;

export type BrandSlotRules = {
  formats: readonly BrandFormat[];
  /** Upload limit in bytes (checked from Content-Length before the body is read, then while reading). */
  maxBytes: number;
  /** Raster minimums in pixels (an SVG scales, so only its proportions are checked). */
  minWidth: number;
  minHeight: number;
  /** Width must equal height (favicon). */
  square: boolean;
};

export const BRAND_RULES: Record<BrandSlot, BrandSlotRules> = {
  "logo-light": { formats: ["png", "svg", "webp"], maxBytes: MB, minWidth: 200, minHeight: 16, square: false },
  "logo-dark": { formats: ["png", "svg", "webp"], maxBytes: MB, minWidth: 200, minHeight: 16, square: false },
  favicon: { formats: ["png", "svg", "ico"], maxBytes: 256 * KB, minWidth: 48, minHeight: 48, square: true },
};

/** Largest raster side accepted (decoding is bounded by this squared). */
export const BRAND_MAX_SIDE = 5000;
export const BRAND_MAX_PIXELS = BRAND_MAX_SIDE * BRAND_MAX_SIDE;

/** PNG renditions: logos fit in 1280 x 160 (emails and PDFs show them about 36 px / 28 pt tall), favicon 180 x 180. */
export const LOGO_PNG_MAX = { width: 1280, height: 160 } as const;
export const FAVICON_PNG_SIZE = 180;

/** Version in URLs: the first 12 hex characters of the stored file's SHA-256. */
export function brandVersion(sha256: string): string {
  return sha256.slice(0, 12).toLowerCase();
}

/**
 * original: the stored file; png: its PNG rendition (transparent); apple: the favicon's rendition on an opaque
 * background (apple-touch-icon; iOS draws transparent pixels black). Only the favicon has an apple variant.
 */
export type BrandFileVariant = "original" | "png" | "apple";

const VARIANT_SUFFIX: Record<BrandFileVariant, string> = { original: "", png: ".png", apple: "-apple.png" };

/**
 * "/brand/logo-light?v=3f2a9c1b0d4e" (the stored file), "/brand/logo-light.png?v=..." (its PNG rendition) or
 * "/brand/favicon-apple.png?v=..." (the apple-touch-icon).
 */
export function brandFilePath(slot: BrandSlot, version: string, variant: BrandFileVariant = "original"): string {
  return `/brand/${slot}${VARIANT_SUFFIX[variant]}?v=${encodeURIComponent(version)}`;
}

/**
 * The [file] segment of GET /brand/:file: "logo-light", "logo-dark", "favicon", any of them + ".png", or
 * "favicon-apple.png".
 */
export function parseBrandFile(name: unknown): { slot: BrandSlot; variant: BrandFileVariant } | null {
  if (typeof name !== "string") return null;
  if (name === `favicon${VARIANT_SUFFIX.apple}`) return { slot: "favicon", variant: "apple" };
  const png = name.endsWith(".png");
  const base = png ? name.slice(0, -4) : name;
  return isBrandSlot(base) ? { slot: base, variant: png ? "png" : "original" } : null;
}

/** File name in Content-Disposition. */
export function brandFileName(slot: BrandSlot, format: BrandFormat, variant: BrandFileVariant): string {
  return variant === "original" ? `${slot}.${format}` : `${slot}${VARIANT_SUFFIX[variant]}`;
}

/** An uploaded slot as pages and the Settings card see it: everything but the bytes. */
export type BrandAssetInfo = {
  slot: BrandSlot;
  format: BrandFormat;
  mime: string;
  width: number;
  height: number;
  byteSize: number;
  /** brandVersion(sha256): the first 12 hex characters of the stored file's SHA-256. */
  version: string;
  /** Size of the PNG rendition (emails, PDFs, apple-touch-icon), or null when none could be made. */
  png: { width: number; height: number } | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type BrandingState = Record<BrandSlot, BrandAssetInfo | null>;

export const EMPTY_BRANDING: BrandingState = Object.freeze({ "logo-light": null, "logo-dark": null, favicon: null });

/** An image to draw: versioned path and intrinsic size (sets width and height, so nothing shifts while it loads). */
export type BrandImage = { src: string; width: number; height: number };

/** png: the transparent PNG rendition (`src`, a fallback icon) and its opaque copy for apple-touch-icon (`apple`). */
export type BrandFavicon = { src: string; type: string; png: { src: string; apple: string; size: number } | null };

/** What every surface uses; null = the built-in logo or app/icon.svg for that slot. */
export type EffectiveBranding = { logoLight: BrandImage | null; logoDark: BrandImage | null; favicon: BrandFavicon | null };

export const BUILT_IN_BRANDING: EffectiveBranding = Object.freeze({ logoLight: null, logoDark: null, favicon: null });

function imageOf(info: BrandAssetInfo | null): BrandImage | null {
  if (!info || !(info.width > 0) || !(info.height > 0)) return null;
  return { src: brandFilePath(info.slot, info.version), width: info.width, height: info.height };
}

/** The effective branding for a state (each slot falls back to the built-in look on its own). */
export function effectiveBranding(state: BrandingState | null | undefined): EffectiveBranding {
  if (!state) return BUILT_IN_BRANDING;
  const fav = state.favicon;
  return {
    logoLight: imageOf(state["logo-light"]),
    logoDark: imageOf(state["logo-dark"]),
    favicon: fav
      ? {
          src: brandFilePath("favicon", fav.version),
          type: fav.mime,
          png: fav.png
            ? { src: brandFilePath("favicon", fav.version, "png"), apple: brandFilePath("favicon", fav.version, "apple"), size: fav.png.width }
            : null,
        }
      : null,
  };
}

/** The logo for a background, or null for the built-in one. */
export function logoFor(branding: EffectiveBranding, onDark: boolean): BrandImage | null {
  return onDark ? branding.logoDark : branding.logoLight;
}

/**
 * Display size for an image shown `height` px tall, at most `maxWidth` wide (a wide logo gets shorter instead). Whole
 * pixels, at least 1.
 */
export function fitHeight(image: { width: number; height: number }, height: number, maxWidth: number): { width: number; height: number } {
  if (!(image.width > 0 && image.height > 0)) return { width: height, height };
  let h = height;
  let w = Math.round((h * image.width) / image.height);
  if (w > maxWidth) {
    w = maxWidth;
    h = Math.round((maxWidth * image.height) / image.width);
  }
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

/** Next.js metadata `icons` for an uploaded favicon (null = keep app/icon.svg). */
export function faviconIcons(favicon: BrandFavicon | null): {
  icon: { url: string; type: string; sizes?: string }[];
  shortcut: { url: string; type: string }[];
  apple?: { url: string; sizes: string; type: string }[];
} | null {
  if (!favicon) return null;
  const png = favicon.png;
  return {
    icon: [
      { url: favicon.src, type: favicon.type, ...(favicon.type === "image/svg+xml" ? { sizes: "any" } : {}) },
      // A PNG for browsers that cannot use the original (SVG favicons in older Safari).
      ...(png && favicon.type !== "image/png" ? [{ url: png.src, type: "image/png", sizes: `${png.size}x${png.size}` }] : []),
    ],
    shortcut: [{ url: favicon.src, type: favicon.type }],
    // Opaque (iOS fills transparent pixels of a home-screen icon with black).
    ...(png ? { apple: [{ url: png.apple, sizes: `${png.size}x${png.size}`, type: "image/png" }] } : {}),
  };
}

/** A PNG rendition with its pixel size (invoice and credit note PDFs). */
export type RasterLogo = { png: Uint8Array; width: number; height: number };

// ---------- Emails ----------

/** The email header logo: absolute URLs of the PNG renditions (light always, dark when uploaded too). */
export type EmailLogo = { alt: string; light: BrandImage; dark: BrandImage | null };

/** Email logo height in px (the built-in mark is 32). */
export const EMAIL_LOGO_HEIGHT = 36;
export const EMAIL_LOGO_MAX_WIDTH = 240;

function absolute(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * The email logo from the stored renditions: null without a light logo (emails keep the built-in table-and-text logo,
 * which needs no image). A dark logo alone is never used in emails: most clients show the light layout.
 */
export function emailLogoFrom(state: BrandingState, appUrl: string, alt: string): EmailLogo | null {
  const light = state["logo-light"];
  if (!light?.png) return null;
  const dark = state["logo-dark"];
  const size = (png: { width: number; height: number }) => fitHeight(png, EMAIL_LOGO_HEIGHT, EMAIL_LOGO_MAX_WIDTH);
  return {
    alt,
    light: { src: absolute(appUrl, brandFilePath("logo-light", light.version, "png")), ...size(light.png) },
    dark: dark?.png ? { src: absolute(appUrl, brandFilePath("logo-dark", dark.version, "png")), ...size(dark.png) } : null,
  };
}

// ---------- Admin card copy ----------

export const BRAND_AUDIT_ACTIONS = {
  uploaded: "Uploaded branding image",
  replaced: "Replaced branding image",
  removed: "Removed branding image",
} as const;

export type BrandSlotCopy = { title: string; hint: string; builtIn: string; dark: boolean; accept: string };

export const BRANDING_COPY = {
  title: "Branding",
  description: "Logos for light and dark backgrounds, and the browser tab icon.",
  icon: "palette" satisfies IconName,
  note: "Changes show on the website at once. Remove brings back the built-in look.",
  slots: {
    "logo-light": {
      title: "Logo for light backgrounds",
      hint: "PNG, SVG or WebP with a transparent background, at least 200 px wide, up to 1 MB. Shown about 34 px tall: website, portal, admin, emails and invoices.",
      builtIn: "Built-in logo",
      dark: false,
      accept: ".png,.svg,.webp,image/png,image/svg+xml,image/webp",
    },
    "logo-dark": {
      title: "Logo for dark backgrounds",
      hint: "PNG, SVG or WebP with a transparent background, at least 200 px wide, up to 1 MB. Shown about 34 px tall on dark backgrounds, and in emails opened in dark mode when a light logo is uploaded too.",
      builtIn: "Built-in logo",
      dark: true,
      accept: ".png,.svg,.webp,image/png,image/svg+xml,image/webp",
    },
    favicon: {
      title: "Favicon",
      hint: "Square PNG, SVG or ICO, at least 48 x 48 px, up to 256 KB. Shown in browser tabs and bookmarks.",
      builtIn: "Built-in icon",
      dark: false,
      accept: ".png,.svg,.ico,image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon",
    },
  } satisfies Record<BrandSlot, BrandSlotCopy>,
  upload: "Upload",
  replace: "Replace",
  remove: "Remove",
  dropHint: "You can also drop a file on the preview.",
  removeTitle: (title: string) => `Remove the ${title.toLowerCase()}?`,
  removeBody: "The built-in look comes back everywhere at once. You can upload a file again at any time.",
  toasts: {
    uploaded: (title: string) => `${title} updated.`,
    removed: (title: string) => `${title} removed. The built-in look is back.`,
  },
  preview: (title: string) => `Current ${title.toLowerCase()}`,
} as const;

/** Labels for the formats a slot accepts ("PNG, SVG or WebP"). */
export function acceptedFormatsLabel(slot: BrandSlot): string {
  const labels = BRAND_RULES[slot].formats.map((f) => BRAND_FORMAT_LABEL[f]);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}` : (labels[0] ?? "");
}

/** "1 MB", "256 KB", "23.4 KB", "812 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${Number((bytes / MB).toFixed(bytes % MB === 0 ? 0 : 1))} MB`;
  if (bytes >= KB) return `${Number((bytes / KB).toFixed(bytes % KB === 0 ? 0 : 1))} KB`;
  return `${bytes} bytes`;
}

/** "PNG · 512 × 128 px · 23.4 KB" (SVG: "SVG · 512 × 128 · 1.2 KB", its size is a proportion, not pixels). */
export function describeAsset(info: Pick<BrandAssetInfo, "format" | "width" | "height" | "byteSize">): string {
  const dims = `${info.width} × ${info.height}${info.format === "svg" ? "" : " px"}`;
  return [BRAND_FORMAT_LABEL[info.format], dims, formatBytes(info.byteSize)].join(" · ");
}

export const BRAND_MESSAGES = {
  empty: "Choose a file to upload.",
  tooLarge: (slot: BrandSlot) => `The file is larger than ${formatBytes(BRAND_RULES[slot].maxBytes)}.`,
  wrongType: (slot: BrandSlot) => `Upload a ${acceptedFormatsLabel(slot)} file.`,
  notImage: (slot: BrandSlot) => `This file isn't a ${acceptedFormatsLabel(slot)} image.`,
  damaged: "This image is damaged or can't be read.",
  tooSmall: (slot: BrandSlot) =>
    BRAND_RULES[slot].square
      ? `The icon must be at least ${BRAND_RULES[slot].minWidth} × ${BRAND_RULES[slot].minHeight} px.`
      : `The logo must be at least ${BRAND_RULES[slot].minWidth} px wide and ${BRAND_RULES[slot].minHeight} px tall.`,
  tooBig: `The image must be at most ${BRAND_MAX_SIDE} × ${BRAND_MAX_SIDE} px.`,
  notSquare: "The icon must be square (the same width and height).",
  bodyType: "Send the image file as the request body.",
} as const;

/**
 * Quick checks in the browser before uploading (size and file type by name or type); the server decides from the
 * bytes. Returns the message to show, or null.
 */
export function clientFileProblem(slot: BrandSlot, file: { name: string; size: number; type: string }): string | null {
  if (file.size === 0) return BRAND_MESSAGES.empty;
  if (file.size > BRAND_RULES[slot].maxBytes) return BRAND_MESSAGES.tooLarge(slot);
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const byExt: Record<string, BrandFormat> = { png: "png", webp: "webp", svg: "svg", ico: "ico" };
  const byType = formatFromMime(file.type) ?? (file.type === "image/vnd.microsoft.icon" ? "ico" : null);
  const format = byType ?? byExt[ext] ?? null;
  if (format && BRAND_RULES[slot].formats.includes(format)) return null;
  // Unknown types (some systems send none for .ico or .svg) go to the server, which sniffs the bytes.
  if (!format && file.type === "" && ext === "") return null;
  return BRAND_MESSAGES.wrongType(slot);
}
