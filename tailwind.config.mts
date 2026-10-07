import type { Config } from "tailwindcss";
import { fontSizes, layout, palette, radii, screens, semantic, shadows } from "./lib/design/tokens";

// Loaded by Tailwind 4 through `@config` in app/globals.css. Tokens are defined in lib/design/tokens.ts only.
// .mts so Node loads it as ESM without the "typeless package.json" warning (package.json has no "type").
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: { ...palette, ...semantic },
      borderRadius: radii,
      boxShadow: shadows,
      screens,
      maxWidth: { store: layout.storeMax, portal: layout.portalMax, admin: layout.adminMax },
      fontFamily: {
        sans: ["var(--font-manrope)", "ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
      fontSize: fontSizes as unknown as NonNullable<Config["theme"]>["fontSize"],
      keyframes: {
        "skeleton-pulse": { "0%, 100%": { opacity: "1" }, "50%": { opacity: ".55" } },
        "enter-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "drawer-in": { from: { opacity: "0", transform: "translateX(40px)" }, to: { opacity: "1", transform: "translateX(0)" } },
      },
      animation: {
        skeleton: "skeleton-pulse 1.4s ease-in-out infinite",
        "spin-fast": "spin 0.8s linear infinite",
        "enter-up": "enter-up 250ms ease both",
        "drawer-in": "drawer-in 200ms ease both",
      },
    },
  },
};

export default config;
