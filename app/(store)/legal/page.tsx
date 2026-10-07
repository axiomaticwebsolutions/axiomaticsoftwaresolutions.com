import { redirect } from "next/navigation";
import { DEFAULT_LEGAL_DOC, legalDocHref } from "@/content/legal/documents";

/** /legal has no page of its own: it opens the terms of service (docs/decisions.md > Phase 2). */
export default function LegalIndexPage(): never {
  redirect(legalDocHref(DEFAULT_LEGAL_DOC));
}
