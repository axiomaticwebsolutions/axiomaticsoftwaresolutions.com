/**
 * Branding model (lib/branding/model.ts): versioned URLs, the /brand/:file names, display sizes, the effective
 * branding and its built-in fallback, favicon metadata, the email logo, client checks and copy; the email layout with
 * an uploaded logo; the /brand Content-Security-Policy in middleware.ts.
 */
import * as pageStaticInfo from "next/dist/build/analysis/get-page-static-info";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  BRAND_RULES,
  brandFilePath,
  brandVersion,
  BUILT_IN_BRANDING,
  clientFileProblem,
  describeAsset,
  effectiveBranding,
  emailLogoFrom,
  EMPTY_BRANDING,
  faviconIcons,
  fitHeight,
  formatBytes,
  logoFor,
  parseBrandFile,
  type BrandAssetInfo,
  type BrandingState,
} from "@/lib/branding/model";
import { emailDocumentHtml } from "@/lib/email/layout";
import { BRAND_ASSET_CSP } from "@/lib/security/csp";
import { config, middleware } from "@/middleware";

const SHA = "3f2a9c1b0d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeef";

function info(slot: BrandAssetInfo["slot"], over: Partial<BrandAssetInfo> = {}): BrandAssetInfo {
  return {
    slot,
    format: "png",
    mime: "image/png",
    width: 800,
    height: 200,
    byteSize: 23_456,
    version: brandVersion(SHA),
    png: { width: 640, height: 160 },
    updatedAt: "2026-10-08T10:00:00.000Z",
    updatedBy: "Owner",
    ...over,
  };
}

describe("versioned file URLs", () => {
  it("uses the first 12 hex characters of the SHA-256 as ?v=", () => {
    expect(brandVersion(SHA)).toBe("3f2a9c1b0d4e");
    expect(brandVersion(SHA.toUpperCase())).toBe("3f2a9c1b0d4e");
    expect(brandFilePath("logo-light", "3f2a9c1b0d4e")).toBe("/brand/logo-light?v=3f2a9c1b0d4e");
    expect(brandFilePath("favicon", "abc", "png")).toBe("/brand/favicon.png?v=abc");
    expect(brandFilePath("favicon", "abc", "apple")).toBe("/brand/favicon-apple.png?v=abc");
  });

  it("parses /brand/:file names and refuses anything else", () => {
    expect(parseBrandFile("logo-light")).toEqual({ slot: "logo-light", variant: "original" });
    expect(parseBrandFile("logo-dark.png")).toEqual({ slot: "logo-dark", variant: "png" });
    expect(parseBrandFile("favicon")).toEqual({ slot: "favicon", variant: "original" });
    expect(parseBrandFile("favicon-apple.png")).toEqual({ slot: "favicon", variant: "apple" });
    for (const bad of ["logo-light.svg", "LOGO-LIGHT", "../favicon", "favicon.png.png", "", "logo", undefined, ["favicon"], "logo-light-apple.png", "favicon-apple"]) {
      expect(parseBrandFile(bad), String(bad)).toBeNull();
    }
  });
});

describe("display sizes", () => {
  it("scales to the height, and a wide logo gets shorter instead of passing the max width", () => {
    expect(fitHeight({ width: 800, height: 200 }, 34, 180)).toEqual({ width: 136, height: 34 });
    expect(fitHeight({ width: 1200, height: 100 }, 34, 180)).toEqual({ width: 180, height: 15 });
    expect(fitHeight({ width: 0, height: 0 }, 34, 180)).toEqual({ width: 34, height: 34 });
    expect(fitHeight({ width: 10_000, height: 1 }, 34, 180)).toEqual({ width: 180, height: 1 });
  });
});

describe("effective branding", () => {
  it("is the built-in look for every slot when nothing is uploaded (or the state is missing)", () => {
    expect(effectiveBranding(EMPTY_BRANDING)).toEqual({ logoLight: null, logoDark: null, favicon: null });
    expect(effectiveBranding(null)).toBe(BUILT_IN_BRANDING);
    expect(faviconIcons(effectiveBranding(EMPTY_BRANDING).favicon)).toBeNull();
  });

  it("falls back per slot and versions every URL", () => {
    const state: BrandingState = { ...EMPTY_BRANDING, "logo-light": info("logo-light") };
    const branding = effectiveBranding(state);
    expect(branding.logoLight).toEqual({ src: "/brand/logo-light?v=3f2a9c1b0d4e", width: 800, height: 200 });
    expect(branding.logoDark).toBeNull();
    expect(logoFor(branding, false)).toBe(branding.logoLight);
    expect(logoFor(branding, true)).toBeNull();
  });

  it("turns an uploaded favicon into metadata icons with the opaque 180 px PNG as apple-touch-icon", () => {
    const svg = effectiveBranding({ ...EMPTY_BRANDING, favicon: info("favicon", { format: "svg", mime: "image/svg+xml", width: 64, height: 64, png: { width: 180, height: 180 } }) });
    expect(faviconIcons(svg.favicon)).toEqual({
      icon: [
        { url: "/brand/favicon?v=3f2a9c1b0d4e", type: "image/svg+xml", sizes: "any" },
        { url: "/brand/favicon.png?v=3f2a9c1b0d4e", type: "image/png", sizes: "180x180" },
      ],
      shortcut: [{ url: "/brand/favicon?v=3f2a9c1b0d4e", type: "image/svg+xml" }],
      apple: [{ url: "/brand/favicon-apple.png?v=3f2a9c1b0d4e", sizes: "180x180", type: "image/png" }],
    });
    const ico = effectiveBranding({ ...EMPTY_BRANDING, favicon: info("favicon", { format: "ico", mime: "image/x-icon", width: 48, height: 48, png: null }) });
    expect(faviconIcons(ico.favicon)).toEqual({
      icon: [{ url: "/brand/favicon?v=3f2a9c1b0d4e", type: "image/x-icon" }],
      shortcut: [{ url: "/brand/favicon?v=3f2a9c1b0d4e", type: "image/x-icon" }],
    });
  });
});

describe("email logo", () => {
  it("needs a light logo; the dark one is added when uploaded too; absolute APP_URL rendition URLs", () => {
    expect(emailLogoFrom(EMPTY_BRANDING, "https://shop.example", "Brand")).toBeNull();
    expect(emailLogoFrom({ ...EMPTY_BRANDING, "logo-dark": info("logo-dark") }, "https://shop.example", "Brand")).toBeNull();
    const light = emailLogoFrom({ ...EMPTY_BRANDING, "logo-light": info("logo-light") }, "https://shop.example/", "Brand");
    expect(light).toEqual({ alt: "Brand", light: { src: "https://shop.example/brand/logo-light.png?v=3f2a9c1b0d4e", width: 144, height: 36 }, dark: null });
    const both = emailLogoFrom({ ...EMPTY_BRANDING, "logo-light": info("logo-light"), "logo-dark": info("logo-dark", { png: { width: 1280, height: 80 } }) }, "https://shop.example", "Brand");
    expect(both?.dark).toEqual({ src: "https://shop.example/brand/logo-dark.png?v=3f2a9c1b0d4e", width: 240, height: 15 });
  });

  const footer = { legalName: "Seller", address: "1 Road", city: "Pune", state: "Maharashtra", pin: "411001", supportEmail: "help@shop.example" };
  const base = { subject: "Hello", preheader: "Hi", contentHtml: "<p>Body</p>", footer, appUrl: "https://shop.example" };

  it("keeps the built-in table-and-text logo without an upload", () => {
    const html = emailDocumentHtml(base);
    expect(html).toContain(">Axiomatic</div>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<style>");
  });

  it("shows the uploaded logo by absolute URL, and the dark one through <picture> with a dark backdrop", () => {
    const light = emailLogoFrom({ ...EMPTY_BRANDING, "logo-light": info("logo-light") }, "https://shop.example", "Axiomatic & Co")!;
    const html = emailDocumentHtml({ ...base, logo: light });
    expect(html).toContain('<img src="https://shop.example/brand/logo-light.png?v=3f2a9c1b0d4e" width="144" height="36" alt="Axiomatic &amp; Co"');
    expect(html).not.toContain("<picture>");
    expect(html).not.toContain(">Axiomatic</div>");
    const both = emailLogoFrom({ ...EMPTY_BRANDING, "logo-light": info("logo-light"), "logo-dark": info("logo-dark") }, "https://shop.example", "Brand")!;
    const dark = emailDocumentHtml({ ...base, logo: both });
    expect(dark).toContain(
      '<picture><source srcset="https://shop.example/brand/logo-dark.png?v=3f2a9c1b0d4e" media="(prefers-color-scheme: dark)" width="144" height="36"><img src="https://shop.example/brand/logo-light.png',
    );
    expect(dark).toMatch(/<style>@media \(prefers-color-scheme: dark\)\{\.axs-logo\{background-color:#[0-9A-Fa-f]{6} !important;\}\}<\/style><\/head>/);
    expect(dark).toContain('<td class="axs-logo"');
    // The rest of the email stays light.
    expect(dark).toContain('<meta name="color-scheme" content="light">');
  });
});

describe("client checks and copy", () => {
  it("limits logos to 1 MB and the favicon to 256 KB", () => {
    expect(BRAND_RULES["logo-light"].maxBytes).toBe(1024 * 1024);
    expect(BRAND_RULES["logo-dark"].formats).toEqual(["png", "svg", "webp"]);
    expect(BRAND_RULES.favicon).toMatchObject({ maxBytes: 256 * 1024, minWidth: 48, square: true, formats: ["png", "svg", "ico"] });
  });

  it("checks size and type before uploading, leaving unknown types to the server", () => {
    expect(clientFileProblem("logo-light", { name: "logo.png", size: 0, type: "image/png" })).toBe("Choose a file to upload.");
    expect(clientFileProblem("logo-light", { name: "logo.png", size: 2 * 1024 * 1024, type: "image/png" })).toBe("The file is larger than 1 MB.");
    expect(clientFileProblem("favicon", { name: "f.png", size: 300 * 1024, type: "image/png" })).toBe("The file is larger than 256 KB.");
    expect(clientFileProblem("logo-light", { name: "logo.jpg", size: 10, type: "image/jpeg" })).toBe("Upload a PNG, SVG or WebP file.");
    expect(clientFileProblem("logo-dark", { name: "logo.ico", size: 10, type: "image/x-icon" })).toBe("Upload a PNG, SVG or WebP file.");
    expect(clientFileProblem("favicon", { name: "f.webp", size: 10, type: "image/webp" })).toBe("Upload a PNG, SVG or ICO file.");
    expect(clientFileProblem("favicon", { name: "favicon.ico", size: 10, type: "" })).toBeNull();
    expect(clientFileProblem("favicon", { name: "favicon.ico", size: 10, type: "image/vnd.microsoft.icon" })).toBeNull();
    expect(clientFileProblem("logo-light", { name: "logo.svg", size: 10, type: "image/svg+xml" })).toBeNull();
    expect(clientFileProblem("logo-light", { name: "blob", size: 10, type: "" })).toBeNull();
  });

  it("describes a stored file", () => {
    expect(formatBytes(812)).toBe("812 bytes");
    expect(formatBytes(23_456)).toBe("22.9 KB");
    expect(formatBytes(256 * 1024)).toBe("256 KB");
    expect(describeAsset(info("logo-light"))).toBe("PNG · 800 × 200 px · 22.9 KB");
    expect(describeAsset(info("logo-light", { format: "svg", byteSize: 1_300 }))).toBe("SVG · 800 × 200 · 1.3 KB");
  });
});

describe("middleware: /brand files get the sandbox policy", () => {
  const { getMiddlewareMatchers } = pageStaticInfo as unknown as {
    getMiddlewareMatchers: (matcher: readonly string[], nextConfig: object) => { regexp: string }[];
  };

  it("sets BRAND_ASSET_CSP on /brand responses instead of a page policy (no nonce, no session needed)", async () => {
    expect(BRAND_ASSET_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    const matchers = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
    for (const path of ["/brand/logo-light", "/brand/favicon.png"]) {
      expect(matchers.some((re) => re.test(path)), path).toBe(true);
      const res = await middleware(new NextRequest(`http://localhost:3000${path}?v=abc`, { headers: { "x-nonce": "forged" } }));
      expect(res.headers.get("content-security-policy"), path).toBe(BRAND_ASSET_CSP);
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("x-middleware-request-x-nonce")).toBeNull();
    }
    // A page whose name merely starts with "brand" keeps the page policy.
    const page = await middleware(new NextRequest("http://localhost:3000/branding"));
    expect(page.headers.get("content-security-policy")).not.toBe(BRAND_ASSET_CSP);
  });
});
