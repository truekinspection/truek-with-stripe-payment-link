import { randomBytes } from "crypto";

import { clearVinReport } from "@/lib/clearvin/client";
import db from "@/lib/db";
import { createResendClient, getResendFrom } from "@/lib/emails/resend-config";
import { sendOwnerCopy } from "@/lib/emails/send-owner-copy";
import { buildReportDeliveryEmailHtml } from "@/lib/emails/templates";
import { computeReportPreviewExpiry } from "@/lib/report-preview-access";
import { getVinValidationError, normalizeVin } from "@/lib/vin-validation";
import { REPORT_PRICE_CENTS } from "@/lib/constants";

// Whop twin of `fulfillCheckoutSession` (the Stripe Payment Link flow).
// Same contract and same side effects, step for step:
//   payment verified -> ClearVin report fetched -> token + payment saved ->
//   report emailed to customer + owner -> caller redirects to /report-preview.
// Idempotent on the Whop payment id: the id is stored (prefixed) in the
// ReportPreviewToken.stripeSessionId column, which is unique — Whop has no
// separate column and none is needed; the column is just the idempotency key.

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function appOrigin(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    "https://www.truekinspection.com";
  return raw.replace(/\/+$/, "");
}

function splitCustomerName(displayName: string): {
  firstName: string;
  lastName: string;
} {
  const t = displayName.trim();
  if (!t) return { firstName: "Customer", lastName: "" };
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

export function whopTokenKey(paymentId: string): string {
  return `whop:${paymentId}`;
}

export async function findWhopReportToken(paymentId: string): Promise<{
  token: string;
  vin: string;
  expired: boolean;
} | null> {
  const row = await db.reportPreviewToken.findUnique({
    where: { stripeSessionId: whopTokenKey(paymentId) },
    select: { token: true, vin: true, expiresAt: true },
  });
  if (!row) return null;
  return { token: row.token, vin: row.vin, expired: row.expiresAt < new Date() };
}

/**
 * Resolves buyer name/email for a VIN from the homepage lead form
 * (the `Report` table) — the Whop mirror of Stripe's customer_details,
 * which the Payment Link collected on its own page.
 */
async function leadForVin(vin: string): Promise<{ name: string; email: string } | null> {
  const lead = await db.report.findFirst({
    where: { vinNumber: vin },
    orderBy: { createdAt: "desc" },
    select: { firstName: true, lastName: true, email: true },
  });
  if (!lead) return null;
  return {
    name: [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim(),
    email: lead.email?.trim() || "",
  };
}

export type FulfillWhopResult =
  | { ok: true; token: string; vin: string }
  | {
      ok: false;
      reason: "missing_data" | "invalid_vin" | "clearvin" | "store";
      message: string;
    };

export async function fulfillWhopPayment(params: {
  paymentId: string;
  vin: string;
  name?: string | null;
  email?: string | null;
  /** Total paid in major units (dollars) when known. */
  amount?: number | null;
}): Promise<FulfillWhopResult> {
  const paymentId = params.paymentId.trim();
  const vin = params.vin ? normalizeVin(params.vin) : "";

  if (!paymentId || !vin) {
    return {
      ok: false,
      reason: "missing_data",
      message: "Missing Whop payment id or VIN.",
    };
  }

  const existing = await findWhopReportToken(paymentId);
  if (existing) {
    if (existing.expired) {
      return {
        ok: false,
        reason: "missing_data",
        message: "This report link has expired (valid for 30 days from purchase).",
      };
    }
    return { ok: true, token: existing.token, vin: existing.vin };
  }

  const vinError = getVinValidationError(vin);
  if (vinError) {
    return { ok: false, reason: "invalid_vin", message: vinError };
  }

  let name = params.name?.trim() || "";
  let email = params.email?.trim() || "";
  if (!name || !email) {
    const lead = await leadForVin(vin).catch(() => null);
    if (lead) {
      if (!name) name = lead.name;
      if (!email) email = lead.email;
    }
  }
  if (!email) {
    return {
      ok: false,
      reason: "missing_data",
      message: "No buyer email available for this payment (no lead found for the VIN).",
    };
  }
  if (!name) name = "Customer";

  const amountPaid =
    typeof params.amount === "number" && Number.isFinite(params.amount) && params.amount > 0
      ? params.amount
      : REPORT_PRICE_CENTS / 100;

  let reportHtml: string;
  let reportIdStr: string | null;
  try {
    const report = await clearVinReport({ vin, format: "html" });
    reportHtml = report.text?.trim() ?? "";
    reportIdStr = report.reportId?.trim() || null;
    if (!reportHtml) {
      return {
        ok: false,
        reason: "clearvin",
        message: "Empty report received from ClearVin.",
      };
    }
  } catch (e) {
    console.error("[fulfillWhopPayment] ClearVin:", e);
    return {
      ok: false,
      reason: "clearvin",
      message: "Could not fetch the ClearVin report. Please contact support.",
    };
  }

  const { firstName, lastName } = splitCustomerName(name);
  const token = generateToken();
  const expiresAt = computeReportPreviewExpiry();

  try {
    await db.$transaction(
      async (tx) => {
        await tx.reportPreviewToken.create({
          data: {
            token,
            html: reportHtml,
            vin,
            clearvinReportId: reportIdStr,
            stripeSessionId: whopTokenKey(paymentId),
            expiresAt,
          },
        });
        await tx.payment.upsert({
          where: { orderID: paymentId },
          create: {
            firstName,
            lastName,
            email,
            plan: `Vehicle History Report — $${amountPaid.toFixed(2)}`,
            orderID: paymentId,
            status: "COMPLETED",
          },
          update: {
            firstName,
            lastName,
            email,
            plan: `Vehicle History Report — $${amountPaid.toFixed(2)}`,
            status: "COMPLETED",
          },
        });
      },
      { maxWait: 20_000, timeout: 30_000 },
    );
  } catch (e) {
    const raced = await findWhopReportToken(paymentId);
    if (raced && !raced.expired) {
      return { ok: true, token: raced.token, vin: raced.vin };
    }
    console.error("[fulfillWhopPayment] DB transaction failed", e);
    return {
      ok: false,
      reason: "store",
      message: "We could not save your order. Please contact support.",
    };
  }

  const origin = appOrigin();
  const reportUrl = `${origin}/report-preview?token=${encodeURIComponent(token)}&vin=${encodeURIComponent(vin)}`;
  const resend = createResendClient();
  const from = getResendFrom();
  const customerLabel =
    [firstName, lastName].filter(Boolean).join(" ").trim() || "Customer";

  if (!resend) {
    console.warn("[fulfillWhopPayment] RESEND_API_KEY not set; skipping emails.");
  } else {
    const emailHtml = buildReportDeliveryEmailHtml({
      customerName: customerLabel,
      reportUrl,
      vin,
      reportId: reportIdStr,
      transactionId: paymentId,
      transactionLabel: "Whop Payment ID",
      customerEmail: email,
    });

    try {
      const customerResult = await resend.emails.send({
        from,
        to: email,
        subject: "Your vehicle history report — TrueK Inspection",
        html: emailHtml,
      });
      if (customerResult.error) {
        console.error(
          "[fulfillWhopPayment] customer report email rejected",
          customerResult.error,
        );
      } else {
        console.info(`[fulfillWhopPayment] customer report email sent to ${email}`);
      }
    } catch (e) {
      console.error("[fulfillWhopPayment] customer report email", e);
    }

    const ownerSent = await sendOwnerCopy(resend, {
      customerEmail: email,
      subject: `[TrueK] Purchase complete — ${vin}`,
      html: buildReportDeliveryEmailHtml({
        customerName: customerLabel,
        reportUrl,
        vin,
        reportId: reportIdStr,
        transactionId: paymentId,
      transactionLabel: "Whop Payment ID",
        customerEmail: email,
        forOwner: true,
      }),
      logContext: "fulfillWhopPayment",
    });
    if (!ownerSent) {
      console.error("[fulfillWhopPayment] owner report email did not send");
    }
  }

  void db.reportPreviewToken
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => {});

  return { ok: true, token, vin };
}
