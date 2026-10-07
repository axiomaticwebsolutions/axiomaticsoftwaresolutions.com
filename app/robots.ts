import type { MetadataRoute } from "next";
import { ROBOTS_DISALLOW, siteUrl } from "@/lib/seo/metadata";

/** robots.txt: the storefront is public; accounts, admin, APIs, dev tools, the purchase flow, /compare and invitation links are not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...ROBOTS_DISALLOW] }],
    sitemap: siteUrl("/sitemap.xml"),
  };
}
