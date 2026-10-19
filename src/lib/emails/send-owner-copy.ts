import type { Resend } from "resend";
import { getOwnerEmails } from "./owner-inbox";
import { getResendFrom } from "./resend-config";

type OwnerCopyPayload = {
  subject: string;
  html: string;
  /** Customer email — used for reply-to. */
  customerEmail: string;
  logContext: string;
};

/**
 * Sends an internal copy to every OWNER_EMAIL address.
 * Supports comma-separated OWNER_EMAIL values (owner + admin).
 * Returns true if at least one owner inbox received the email.
 */
export async function sendOwnerCopy(
  resend: Resend,
  payload: OwnerCopyPayload,
): Promise<boolean> {
  const owners = getOwnerEmails();
  if (owners.length === 0) {
    console.warn(
      `[${payload.logContext}] OWNER_EMAIL not set; skipping owner copy`,
    );
    return false;
  }

  const customerEmail = payload.customerEmail.trim();
  const from = getResendFrom();
  let sent = 0;

  for (const owner of owners) {
    try {
      const result = await resend.emails.send({
        from,
        to: owner,
        replyTo: customerEmail || undefined,
        subject: payload.subject,
        html: payload.html,
      });
      if (result.error) {
        console.error(
          `[${payload.logContext}] owner notification rejected (${owner})`,
          result.error,
        );
        continue;
      }
      sent += 1;
      console.info(`[${payload.logContext}] owner copy sent to ${owner}`);
    } catch (e) {
      console.error(
        `[${payload.logContext}] owner notification email failed (${owner})`,
        e,
      );
    }
  }

  if (sent === 0) {
    console.error(
      `[${payload.logContext}] failed to send owner email to any OWNER_EMAIL inbox`,
    );
    return false;
  }

  return true;
}
