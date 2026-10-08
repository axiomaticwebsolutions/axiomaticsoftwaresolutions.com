/**
 * The one place a message becomes nodemailer mail options, shared by the SMTP and the Amazon SES transports so both
 * build the same MIME message (nodemailer's MailComposer): the From as { name, address } (never a concatenated
 * string), HTML and text parts, and the headers every message carries (Auto-Submitted so autoresponders stay quiet,
 * X-Axs-Template for support). Attachments or List-Unsubscribe, when added, belong here too.
 */
import "server-only";
import type { SendMailOptions } from "nodemailer";
import type { OutgoingEmail } from "../transport";

export function mailOptions(message: OutgoingEmail, from: { name: string; address: string }): SendMailOptions {
  return {
    from: { name: from.name, address: from.address },
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: { "Auto-Submitted": "auto-generated", "X-Axs-Template": message.templateId },
  };
}
