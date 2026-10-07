/**
 * Development transport: nothing leaves the machine. The message is kept in the in-memory dev mailbox
 * (/dev/mailbox, last 50) and the caller logs a one-line summary (template, masked recipient, id), never the
 * subject or body, because those carry codes and links. Refused in production by lib/env.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { recordDevMail } from "../dev-mailbox";
import type { EmailTransport } from "../transport";

export function createConsoleTransport(): EmailTransport {
  return {
    name: "console",
    async send(message) {
      const id = `console-${randomUUID()}`;
      recordDevMail({
        id,
        sentAt: new Date().toISOString(),
        templateId: message.templateId,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      return { messageId: id };
    },
  };
}
