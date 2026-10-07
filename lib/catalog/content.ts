/**
 * Shape of Product.content (FAQs live in Faq(page = slug), not here). Strict, so a typo in a key fails loudly.
 * Shared by the seed, storefront product pages and the admin product editor; client-safe (zod only).
 */
import { z } from "zod";

const textField = (max: number) => z.string().trim().min(1).max(max);

export const productContentSchema = z.strictObject({
  features: z
    .array(z.strictObject({ icon: z.string().regex(/^[a-z0-9_]+$/), title: textField(80), body: textField(300) }))
    .min(1)
    .max(12),
  benefits: z.array(z.strictObject({ title: textField(80), body: textField(300) })).max(6),
  requirements: z.array(z.strictObject({ label: textField(60), value: textField(120) })).max(12),
});

export type ProductContent = z.output<typeof productContentSchema>;
