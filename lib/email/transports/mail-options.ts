/**
 * The one place a message becomes nodemailer mail options, shared by the SMTP and the Amazon SES transports so both
 * build the same MIME message (nodemailer's MailComposer): the From as { name, address } (never a concatenated
 * string), HTML and text parts, and the headers every message carries (Auto-Submitted so autoresponders stay quiet,
 * X-Axs-Template for support). Attachments (the order email's invoice PDF) become nodemailer attachments, so a message
 * with files is multipart/mixed: the multipart/alternative HTML + text part first, then each file as
 * `Content-Disposition: attachment` with its fixed content type. List-Unsubscribe, when added, belongs here too.
 */
import "server-only";
import type { SendMailOptions } from "nodemailer";
import type { OutgoingAttachment, OutgoingEmail } from "../transport";

/** nodemailer attachment options for the message's files (content as a Buffer: never a path or URL nodemailer would fetch). */
export function attachmentOptions(attachments: readonly OutgoingAttachment[]): NonNullable<SendMailOptions["attachments"]> {
  return attachments.map((a) => ({
    filename: a.filename,
    content: a.content,
    contentType: a.contentType,
    contentDisposition: "attachment" as const,
  }));
}

export function mailOptions(message: OutgoingEmail, from: { name: string; address: string }): SendMailOptions {
  const options: SendMailOptions = {
    from: { name: from.name, address: from.address },
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: { "Auto-Submitted": "auto-generated", "X-Axs-Template": message.templateId },
  };
  if (message.attachments && message.attachments.length > 0) options.attachments = attachmentOptions(message.attachments);
  return options;
}
