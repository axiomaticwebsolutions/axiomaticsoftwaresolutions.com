/**
 * Development transport: nothing leaves the machine. The message is kept in the in-memory dev mailbox
 * (/dev/mailbox, last 50) and the caller logs a one-line summary (template, masked recipient, id), never the
 * subject or body, because those carry codes and links. Attachments are kept for download from the mailbox and
 * logged by file name and size only. Refused in production by lib/env.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { log } from "@/lib/log";
import { recordDevMail } from "../dev-mailbox";
import type { EmailTransport } from "../transport";

export function createConsoleTransport(): EmailTransport {
  return {
    name: "console",
    async send(message) {
      const id = `console-${randomUUID()}`;
      const attachments = (message.attachments ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.content.length,
        content: a.content,
      }));
      recordDevMail({
        id,
        sentAt: new Date().toISOString(),
        templateId: message.templateId,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (attachments.length > 0) {
        log.info("email_console_attachments", {
          messageId: id,
          template: message.templateId,
          files: attachments.map((a) => ({ name: a.filename, bytes: a.size })),
        });
      }
      return { messageId: id };
    },
  };
}
