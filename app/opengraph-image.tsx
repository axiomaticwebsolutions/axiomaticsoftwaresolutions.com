import { ImageResponse } from "next/og";
import { palette, tones } from "@/lib/design/tokens";
import { OG_IMAGE_ALT, OG_IMAGE_SIZE, SITE_TAGLINE } from "@/lib/seo/metadata";

/** Default share image (1200x630): logo mark, wordmark and tagline on a lavender gradient. No external fonts. */
export const runtime = "nodejs";
export const alt = OG_IMAGE_ALT;
export const size = { ...OG_IMAGE_SIZE };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          overflow: "hidden",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: `linear-gradient(135deg, ${tones.lavender.soft} 0%, ${tones.lavender.bg} 58%, ${palette.primary.ring} 100%)`,
          color: palette.ink.DEFAULT,
        }}
      >
        <div
          style={{
            position: "absolute",
            right: -90,
            top: -110,
            width: 420,
            height: 420,
            borderRadius: 9999,
            background: tones.pink.bg,
            display: "flex",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 170,
            bottom: -170,
            width: 340,
            height: 340,
            borderRadius: 9999,
            background: tones.blue.bg,
            display: "flex",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <svg width="88" height="88" viewBox="0 0 32 32">
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
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-0.025em", lineHeight: 1 }}>Axiomatic</div>
            <div style={{ marginTop: 8, fontSize: 18, fontWeight: 700, letterSpacing: "0.17em", color: palette.ink["2"] }}>
              SOFTWARE SOLUTIONS
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 860 }}>
          <div style={{ fontSize: 78, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.04 }}>{SITE_TAGLINE}</div>
          <div style={{ marginTop: 26, fontSize: 30, lineHeight: 1.4, color: palette.ink.body }}>
            Billing, GST and cheque printing software for Indian businesses.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
