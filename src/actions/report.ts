"use server";

import db from "@/lib/db";
import { createResendClient, getResendFrom } from "@/lib/emails/resend-config";
import { sendOwnerCopy } from "@/lib/emails/send-owner-copy";
import {
  buildPaymentSuccessEmailHtml,
  buildReportRequestOwnerEmailHtml,
} from "@/lib/emails/templates";

type ReportRequest = {
  firstName: string;
  lastName: string;
  email: string;
  vnNumber: string;
};

/**
 * Landing-page Get Report form: persist lead + notify OWNER only
 * (name, email, VIN). Does not email the customer.
 */
export async function handleReportRequest(data: ReportRequest) {
  try {
    const { firstName, lastName, email, vnNumber } = data;

    if (!firstName || !lastName || !email || !vnNumber) {
      throw new Error("Required fields are missing");
    }

    const report = await db.report.create({
      data: {
        firstName,
        lastName,
        email,
        vinNumber: vnNumber,
      },
    });

    const resend = createResendClient();
    if (!resend) {
      console.warn(
        "[handleReportRequest] RESEND_API_KEY not set; skipping owner email.",
      );
    } else {
      // Owner-only notification — do not email the customer on form submit.
      const ownerSent = await sendOwnerCopy(resend, {
        customerEmail: email,
        subject: `[TrueK] New report request — ${vnNumber}`,
        html: buildReportRequestOwnerEmailHtml({
          firstName,
          lastName,
          email,
          vin: vnNumber,
        }),
        logContext: "handleReportRequest",
      });
      if (!ownerSent) {
        console.error(
          "[handleReportRequest] owner notification did not send",
        );
      }
    }

    return { success: true, data: report };
  } catch (error) {
    console.error("[handleReportRequest]", error);
    return { success: false, error: "Internal Server Error" };
  }
}

/**
 * Legacy payment email helper — prefer `fulfillCheckoutSession` for Payment Link flow.
 * Sends branded payment confirmation to customer and owner copy.
 */
export async function sendPaymentSuccessEmails(data: {
  email: string;
  name: string;
  vin: string;
  orderId: string;
  amount: string;
}) {
  const resend = createResendClient();
  if (!resend) {
    return { success: false };
  }

  try {
    const displayName =
      data.name && data.name !== "Customer" ? data.name : "Valued Customer";
    const from = getResendFrom();
    const amountDisplay = data.amount.replace(/^\$/, "");

    await resend.emails.send({
      from,
      to: data.email,
      subject: "Payment received — TrueK Inspection",
      html: buildPaymentSuccessEmailHtml({
        customerName: displayName,
        orderId: data.orderId,
        amountDisplay,
        currency: "USD",
        vin: data.vin,
      }),
    });

    await sendOwnerCopy(resend, {
      customerEmail: data.email,
      subject: `[TrueK] New payment — ${data.vin}`,
      html: buildPaymentSuccessEmailHtml({
        customerName: displayName,
        orderId: data.orderId,
        amountDisplay,
        currency: "USD",
        vin: data.vin,
        forOwner: true,
        customerEmail: data.email,
      }),
      logContext: "sendPaymentSuccessEmails",
    });

    return { success: true };
  } catch (error) {
    console.error("[sendPaymentSuccessEmails]", error);
    return { success: false };
  }
}
