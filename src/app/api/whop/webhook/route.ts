import { NextRequest, NextResponse } from "next/server";
import { unwrapWebhook } from "@whop/sdk/helpers";

import { clearVinReport } from "@/lib/clearvin/client";
import db from "@/lib/db";
import { createResendClient, getResendFrom } from "@/lib/emails/resend-config";
import { sendOwnerCopy } from "@/lib/emails/send-owner-copy";
import { buildReportDeliveryEmailHtml } from "@/lib/emails/templates";
import { computeReportPreviewExpiry } from "@/lib/report-preview-access";
import { getVinValidationError, normalizeVin } from "@/lib/vin-validation";
import { randomBytes } from "crypto";

// Must run on Node.js runtime — crypto operations required.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── helpers ──────────────────────────────────────────────────────────────────

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

function splitName(displayName: string): {
  firstName: string;
  lastName: string;
} {
  const t = displayName.trim();
  if (!t) return { firstName: "Customer", lastName: "" };
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Loose shape of Whop's payment.succeeded / payment.completed event data.
 * We only declare what we use; the SDK types `data` as `unknown` so we cast.
 */
interface WhopPaymentData {
  id: string;
  status?: string;
  amount?: number;       // in cents (varies by Whop version)
  total?: number;        // alternative field
  user?: {
    email?: string;
    name?: string;
    username?: string;
  };
  metadata?: Record<string, string>;
}

interface WhopWebhookEvent {
  type: string;
  data: WhopPaymentData;
}

// ── Core fulfillment ─────────────────────────────────────────────────────────

/**
 * Fulfills a Whop payment event. Idempotent: if the payment.orderID
 * already exists in the DB, the event is silently acknowledged.
 */
async function fulfillWhopPayment(
  paymentId: string,
  data: WhopPaymentData,
): Promise<{ ok: boolean; reason?: string }> {
  // Idempotency — payment orderID is unique in the DB.
  const existing = await db.payment.findUnique({
    where: { orderID: paymentId },
    select: { id: true },
  });
  if (existing) {
    console.info(
      `[whop-webhook] already fulfilled payment ${paymentId}, skipping.`,
    );
    return { ok: true };
  }

  // Extract VIN from checkout metadata
  const rawVin = data.metadata?.vin?.trim() ?? "";
  if (!rawVin) {
    console.error(
      `[whop-webhook] payment ${paymentId} has no vin in metadata`,
    );
    return { ok: false, reason: "missing_vin" };
  }
  const vin = normalizeVin(rawVin);
  const vinError = getVinValidationError(vin);
  if (vinError) {
    console.error(`[whop-webhook] invalid vin "${vin}": ${vinError}`);
    return { ok: false, reason: "invalid_vin" };
  }

  // Extract customer info from Whop user object
  const rawName =
    data.user?.name?.trim() ||
    data.user?.username?.trim() ||
    "Customer";
  const email = data.user?.email?.trim() ?? "";
  if (!email) {
    console.error(
      `[whop-webhook] payment ${paymentId} has no customer email`,
    );
    return { ok: false, reason: "missing_email" };
  }

  // Amount — Whop may send cents or dollars depending on API version
  const rawAmount = data.amount ?? data.total ?? 0;
  // If the value looks like cents (> 100 for a $1 product), divide; otherwise keep.
  const amountPaid = rawAmount > 500 ? rawAmount / 100 : rawAmount;

  // Fetch ClearVIN report
  let reportHtml: string;
  let reportIdStr: string | null;
  try {
    const report = await clearVinReport({ vin, format: "html" });
    reportHtml = report.text?.trim() ?? "";
    reportIdStr = report.reportId?.trim() || null;
    if (!reportHtml) {
      console.error(`[whop-webhook] empty report for VIN ${vin}`);
      return { ok: false, reason: "clearvin_empty" };
    }
  } catch (e) {
    console.error("[whop-webhook] ClearVIN error:", e);
    return { ok: false, reason: "clearvin_error" };
  }

  const { firstName, lastName } = splitName(rawName);
  const token = generateToken();
  const expiresAt = computeReportPreviewExpiry();

  // Persist token + payment in a transaction
  try {
    await db.$transaction(
      async (tx) => {
        await tx.reportPreviewToken.create({
          data: {
            token,
            html: reportHtml,
            vin,
            clearvinReportId: reportIdStr,
            // stripeSessionId intentionally left null for Whop payments
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
    // Race: another webhook delivery may have won — check DB.
    const raced = await db.payment.findUnique({ where: { orderID: paymentId }, select: { id: true } });
    if (raced) {
      console.info(`[whop-webhook] race-condition — payment ${paymentId} already stored.`);
      return { ok: true };
    }
    console.error("[whop-webhook] DB transaction failed:", e);
    return { ok: false, reason: "db_error" };
  }

  // Send emails (same logic as Stripe fulfillment)
  const origin = appOrigin();
  const reportUrl = `${origin}/report-preview?token=${encodeURIComponent(token)}&vin=${encodeURIComponent(vin)}`;
  const resend = createResendClient();
  const from = getResendFrom();
  const customerLabel =
    [firstName, lastName].filter(Boolean).join(" ").trim() || "Customer";

  if (!resend) {
    console.warn("[whop-webhook] RESEND_API_KEY not set; skipping emails.");
  } else {
    const emailHtml = buildReportDeliveryEmailHtml({
      customerName: customerLabel,
      reportUrl,
      vin,
      reportId: reportIdStr,
      transactionId: paymentId,
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
          "[whop-webhook] customer email rejected:",
          customerResult.error,
        );
      } else {
        console.info(`[whop-webhook] customer email sent to ${email}`);
      }
    } catch (e) {
      console.error("[whop-webhook] customer email error:", e);
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
        customerEmail: email,
        forOwner: true,
      }),
      logContext: "whop-webhook",
    });
    if (!ownerSent) {
      console.error("[whop-webhook] owner email did not send");
    }
  }

  // Cleanup expired tokens (fire-and-forget)
  void db.reportPreviewToken
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => {});

  return { ok: true };
}

// ── Route handler ─────────────────────────────────────────────────────────────

/**
 * POST /api/whop/webhook
 *
 * Receives Whop webhook events, verifies the HMAC signature using
 * @whop/sdk `unwrapWebhook`, then handles `payment.succeeded` /
 * `payment.completed` by calling our fulfillment logic.
 *
 * IMPORTANT: Do NOT call request.json() before unwrapWebhook —
 * signature verification requires the raw body bytes.
 */
export async function POST(request: NextRequest) {
  const webhookSecret = process.env.WHOP_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    console.error("[whop-webhook] WHOP_WEBHOOK_SECRET is not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured on server." },
      { status: 500 },
    );
  }

  // Read raw body — must happen BEFORE unwrapWebhook
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Could not read body." }, { status: 400 });
  }

  const headers = Object.fromEntries(request.headers.entries());

  let event: WhopWebhookEvent;
  try {
    event = unwrapWebhook(rawBody, {
      headers,
      key: webhookSecret,
    }) as WhopWebhookEvent;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[whop-webhook] signature verification failed:", msg);
    return NextResponse.json(
      { error: `Webhook signature invalid: ${msg}` },
      { status: 400 },
    );
  }

  console.info(`[whop-webhook] received event: ${event.type}`);

  // Handle payment success events
  if (
    event.type === "payment.succeeded" ||
    event.type === "payment.completed"
  ) {
    const paymentData = event.data;
    const paymentId = paymentData?.id;

    if (!paymentId) {
      console.error("[whop-webhook] event missing payment id:", event);
      return NextResponse.json(
        { error: "Missing payment id in event." },
        { status: 400 },
      );
    }

    const result = await fulfillWhopPayment(paymentId, paymentData);
    if (!result.ok) {
      // Return 200 so Whop does not retry endlessly for non-retriable errors
      // (e.g., missing VIN in metadata — retrying won't help).
      // For retriable errors (DB, ClearVIN), return 500 so Whop retries.
      const retriable = result.reason === "clearvin_error" || result.reason === "db_error";
      return NextResponse.json(
        { error: result.reason },
        { status: retriable ? 500 : 200 },
      );
    }
  }

  // Acknowledge all other event types with 200
  return NextResponse.json({ received: true }, { status: 200 });
}
