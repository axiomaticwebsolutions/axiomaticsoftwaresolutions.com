/**
 * Admin catalog DTOs (Products & categories, Plans & pricing, Releases): what the /api/admin catalog routes return and
 * the admin pages render. Plain JSON (ISO date strings, sizes as numbers, never storage keys). Types only, client-safe.
 */

export type CatalogTone = "sage" | "peach" | "blue" | "lavender" | "pink";
export type CatalogPlatform = "windows" | "macos" | "android";
export type PlanTypeKey = "TRIAL" | "ONE_TIME" | "ANNUAL" | "SUBSCRIPTION" | "DEVICE_ADDON" | "MAINTENANCE";
export type BillingIntervalKey = "MONTH" | "YEAR";
export type ProductStatusKey = "DRAFT" | "PUBLISHED" | "HIDDEN";
export type ReleaseRawStatus = "DRAFT" | "PUBLISHED" | "WITHDRAWN";
/** Release status as the list shows it: "latest" = the newest published stable release of its product. */
export type ReleaseStatusKey = "latest" | "published" | "draft" | "withdrawn";

export type AdminOption = { id: string; name: string };

/** Category as the products page lists it (and the category dialog edits it). */
export type AdminCategoryRow = {
  id: string;
  name: string;
  blurb: string | null;
  tone: CatalogTone;
  icon: string;
  sortOrder: number;
  /** Products in the category (any status) and how many of them are published. */
  productCount: number;
  publishedCount: number;
};

export type AdminProductRow = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  categoryId: string;
  categoryName: string;
  platforms: CatalogPlatform[];
  status: ProductStatusKey;
  rank: number;
  /** Newest published stable release. */
  latest: { version: string; releasedAt: string } | null;
  /** Plans on sale (archived plans left out). */
  planCount: number;
  /** Cheapest paid main plan on sale (storefront "From"), excluding GST. */
  fromPricePaise: number | null;
  updatedAt: string;
};

export type AdminProductPlanSummary = {
  id: string;
  name: string;
  type: PlanTypeKey;
  multiDevice: boolean;
  deviceLimit: number | null;
  perUnit: string | null;
  pricePaise: number;
  archived: boolean;
};

/** Product.content as stored (it may not validate yet: drafts start empty). */
export type AdminProductContent = {
  features: { icon: string; title: string; body: string }[];
  benefits: { title: string; body: string }[];
  requirements: { label: string; value: string }[];
};

export type AdminProductDetail = AdminProductRow & {
  tagline: string;
  summary: string;
  icon: string;
  /** Own tone, or null to use the category's. */
  tone: CatalogTone | null;
  demoEnabled: boolean;
  content: AdminProductContent;
  /** The content passes productContentSchema (publishing needs it). */
  contentValid: boolean;
  relatedIds: string[];
  hasTrial: boolean;
  /** Licenses exist for the product, so the key prefix (code) can no longer change. */
  codeLocked: boolean;
  plans: AdminProductPlanSummary[];
  /** What publishing still needs ([] when it can be published). */
  publishBlockers: string[];
  createdAt: string;
};

export type AdminPlanRow = {
  id: string;
  productId: string;
  productName: string;
  type: PlanTypeKey;
  name: string;
  summary: string | null;
  pricePaise: number;
  interval: BillingIntervalKey | null;
  trialDays: number | null;
  deviceLimit: number | null;
  perUnit: string | null;
  maxQty: number | null;
  multiDevice: boolean;
  updatesMonths: number | null;
  popular: boolean;
  archived: boolean;
  sortOrder: number;
};

export type AdminPlanDetail = AdminPlanRow & {
  productFullName: string;
  productStatus: ProductStatusKey;
  includes: string[];
  createdAt: string;
  updatedAt: string;
};

export type AdminReleaseRow = {
  id: string;
  productId: string;
  productName: string;
  productCode: string;
  version: string;
  channel: string;
  status: ReleaseStatusKey;
  rawStatus: ReleaseRawStatus;
  releasedAt: string | null;
  createdAt: string;
  firstNote: string | null;
  /** Platforms with an uploaded installer. */
  platforms: CatalogPlatform[];
  /** Size of the Windows installer (else the first one), like the storefront. */
  installerBytes: number | null;
  fileCount: number;
};

export type AdminReleaseFile = {
  id: string;
  platform: CatalogPlatform;
  fileName: string;
  sizeBytes: number;
  sha256: string;
};

export type AdminReleaseDetail = AdminReleaseRow & {
  productFullName: string;
  productPlatforms: CatalogPlatform[];
  notes: string[];
  files: AdminReleaseFile[];
  /** Product platforms without an installer yet. */
  missingPlatforms: CatalogPlatform[];
  /** Object-key prefix in private storage, e.g. "releases/medical-billing/4.2.1/". */
  storagePrefix: string;
};

/** POST /api/admin/releases/:id/files response: the presigned PUT and the token that confirms it. */
export type InstallerUploadTicket = {
  upload: { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };
  uploadToken: string;
};

/** POST /api/admin/releases/:id/files/confirm response. */
export type InstallerConfirmResult = { file: AdminReleaseFile; release: AdminReleaseDetail };

/** Options the catalog forms choose from (server-rendered into the pages). */
export type CatalogFormOptions = {
  categories: (AdminOption & { tone: CatalogTone })[];
  products: (AdminOption & { code: string; platforms: CatalogPlatform[] })[];
};
