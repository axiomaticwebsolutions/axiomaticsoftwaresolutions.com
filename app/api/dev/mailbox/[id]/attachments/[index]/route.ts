/**
 * GET /api/dev/mailbox/:id/attachments/:index (development only): downloads attachment `index` (0-based) of a message
 * in the dev mailbox (lib/email/dev-mailbox.ts; /dev/mailbox links here), e.g. the order email's invoice PDF.
 * 404 in production (the middleware answers 404 for every /api/dev route there, and this handler refuses too), and for
 * unknown messages or indexes. Served as a download with its recorded content type (PDF only), nosniff, no-store.
 */
import { errors, route } from "@/lib/http";
import { getDevMailAttachment } from "@/lib/email/dev-mailbox";
import { attachmentDisposition } from "@/lib/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; index: string }> };

export const GET = route<Context>(async (_req, { params }) => {
  if (process.env.NODE_ENV === "production") throw errors.notFound();
  const { id, index } = await params;
  if (!/^\d{1,3}$/.test(index)) throw errors.notFound();
  const file = getDevMailAttachment(id, Number(index));
  if (!file) throw errors.notFound();
  return new Response(new Uint8Array(file.content), {
    status: 200,
    headers: {
      "content-type": file.contentType === "application/pdf" ? "application/pdf" : "application/octet-stream",
      "content-length": String(file.content.length),
      "content-disposition": attachmentDisposition(file.filename),
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
});
