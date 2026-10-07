import { serializeJsonLd, type JsonLdObject } from "@/lib/seo/json-ld";

export type JsonLdProps = {
  /** One schema.org object or several (each with its own "@context"). Build them with lib/seo/json-ld.ts. */
  data: JsonLdObject | readonly JsonLdObject[];
};

/** Structured data for search engines. Server-safe; the JSON is escaped so it can never close the script element. */
export function JsonLd({ data }: JsonLdProps) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
