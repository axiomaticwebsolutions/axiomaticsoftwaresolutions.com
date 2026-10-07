import { ImageResponse } from "next/og";
import { ICON_PATHS } from "@/components/icons/registry";
import { toIconName } from "@/components/store/active-nav";
import { palette, tones } from "@/lib/design/tokens";
import { RUPEE, formatINR } from "@/lib/money";
import { log } from "@/lib/log";
import { OG_IMAGE_SIZE, SITE_NAME } from "@/lib/seo/metadata";
import { getStoreProduct, getStoreProducts } from "@/lib/storefront/data";
import { platformsLabel, startingPlan, unitLabel } from "@/lib/storefront/derive";

/** Share image per product (1200x630): tone panel, product icon, name, tagline and the "From" price. No web fonts. */
export const runtime = "nodejs";
export const size = { ...OG_IMAGE_SIZE };
export const contentType = "image/png";

// Prerendered per product and refreshed like the page (STOREFRONT_REVALIDATE_SECONDS), so the price on the card follows
// plan edits. Without generateStaticParams the generateImageMetadata route ([__metadata_id__]) renders on every request.
export const revalidate = 300;

/** Every published product's "card" image. Slugs added later render on first request, unknown ones 404. */
export async function generateStaticParams(): Promise<Array<{ slug: string; __metadata_id__: string }>> {
  try {
    const products = await getStoreProducts();
    return products.map((p) => ({ slug: p.id, __metadata_id__: "card" }));
  } catch (error) {
    log.warn("product_og_static_params_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

// Next 15 passes plain params to image routes; Next 16 passes a Promise. Awaiting handles both.
type ImageParams = Promise<{ slug: string }> | { slug: string };

/** One image per product, with a per-product alt text. */
export async function generateImageMetadata({ params }: { params: ImageParams }) {
  const { slug } = await params;
  const product = await getStoreProduct(slug);
  const alt = product ? `${product.name}: ${product.tagline}` : SITE_NAME;
  return [{ id: "card", alt, size, contentType }];
}

export default async function ProductOpengraphImage({ params }: { params: ImageParams; id?: string }) {
  const { slug } = await params;
  const product = await getStoreProduct(slug);
  if (!product) return new Response("Not found", { status: 404 });

  const tone = tones[product.tone];
  const from = startingPlan(product);
  // The built-in OG font has no rupee glyph, so the image says "Rs" (the page itself shows the rupee sign).
  const price = from ? `From ${formatINR(from.pricePaise).replace(RUPEE, "Rs ")} ${unitLabel(from)} + GST` : null;
  const iconPath = ICON_PATHS[toIconName(product.icon)];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 80px",
          background: `linear-gradient(135deg, ${tone.soft} 0%, ${tone.bg} 100%)`,
          color: palette.ink.DEFAULT,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div
            style={{
              width: 104,
              height: 104,
              borderRadius: 28,
              background: palette.surface,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: `2px solid ${tone.line}`,
            }}
          >
            <svg width="60" height="60" viewBox="0 -960 960 960" fill={tone.fg}>
              <path d={iconPath} />
            </svg>
          </div>
          <div
            style={{
              display: "flex",
              padding: "10px 22px",
              borderRadius: 9999,
              border: `2px solid ${tone.line}`,
              background: palette.surface,
              color: tone.fg,
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            {product.category.name}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 1000 }}>
          <div style={{ fontSize: 72, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.05 }}>{product.name}</div>
          <div style={{ marginTop: 22, fontSize: 32, lineHeight: 1.4, color: palette.ink.body }}>{product.tagline}</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", fontSize: 28 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {price ? <div style={{ fontWeight: 800 }}>{price}</div> : null}
            <div style={{ color: palette.ink["2"] }}>{platformsLabel(product.platforms)}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width="48" height="48" viewBox="0 0 32 32">
              <rect width="32" height="32" rx="9" fill={palette.primary.DEFAULT} />
              <path
                d="M8.6 23.6 16 8.4l7.4 15.2"
                fill="none"
                stroke={palette.surface}
                strokeWidth="3.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M13.6 18.4h10" stroke={palette.brand["mark-accent"]} strokeWidth="3.1" strokeLinecap="round" />
            </svg>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.025em" }}>Axiomatic</div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      // ImageResponse defaults to a one-year immutable cache, but the card shows the current price and its URL only
      // changes when this file does: let browsers and CDNs refresh it on the page's revalidation period.
      headers: { "Cache-Control": `public, max-age=${revalidate}, s-maxage=${revalidate}, stale-while-revalidate=86400` },
    },
  );
}
