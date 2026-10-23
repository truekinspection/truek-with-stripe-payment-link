// Whop payment webhook — the heart of the Whop auto-delivery flow.
//
// Flow (mirrors the Stripe Payment Link fulfillment):
//   Whop confirms a payment -> POSTs `payment.succeeded` here ->
//   we read the VIN from the payment metadata (set at checkout creation;
//   email-based lead matching is the fallback) -> fulfillWhopPayment fetches
//   the ClearVin report (paid call happens ONLY here, after payment) ->
//   report saved + emailed to customer and owner.
//
// Setup: Whop Dashboard -> Developer -> Webhooks:
//   URL: https://<your-domain>/api/webhooks/whop   event: payment.succeeded
// Put the signing secret in WHOP_WEBHOOK_SECRET.

import crypto from "crypto";
import { NextResponse } from "next/server";

import db from "@/lib/db";
import {
  fulfillWhopPayment,
  findWhopReportToken,
} from "@/lib/fulfill-whop-payment";
import { fetchWhopPayment, normalizeWhopPayment } from "@/lib/whop";
import { getVinValidationError, normalizeVin } from "@/lib/vin-validation";

export const runtime = "nodejs";

// --- Signature verification (standard webhooks style) -------------------------
// HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{raw-body}", base64,
// sent in `webhook-signature` as "v1,<sig>" entries. Secret may be raw or
// "whsec_<base64>". If WHOP_WEBHOOK_SECRET is unset, verification is skipped
// (dev); a present-but-invalid signature is rejected.
function verifySignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): { attempted: boolean; valid: boolean } {
  const signature =
    headers.get("webhook-signature") || headers.get("whop-signature");
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  if (!signature || !id || !timestamp) return { attempted: false, valid: false };

  let key: Buffer;
  try {
    key = secret.startsWith("whsec_")
      ? Buffer.from(secret.slice("whsec_".length), "base64")
      : Buffer.from(secret, "utf8");
  } catch {
    return { attempted: false, valid: false };
  }

  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  const candidates = signature.split(" ").map((part) => {
    const comma = part.indexOf(",");
    return comma >= 0 ? part.slice(comma + 1) : part;
  });
  const valid = candidates.some((candidate) => {
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  return { attempted: true, valid };
}

function validVin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const vin = normalizeVin(raw);
  return getVinValidationError(vin) ? null : vin;
}

/** Latest lead (homepage form) for an email that has no completed payment yet. */
async function vinFromLeadEmail(email: string): Promise<string | null> {
  const leads = await db.report.findMany({
    where: { email },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { vinNumber: true },
  });
  for (const lead of leads) {
    const vin = validVin(lead.vinNumber);
    if (vin) return vin; // newest lead for this buyer is the purchase intent
  }
  return null;
}

export async function POST(req: Request) {
  const rawBody = await req.text();

  const secret = process.env.WHOP_WEBHOOK_SECRET?.trim();
  if (secret) {
    const { attempted, valid } = verifySignature(rawBody, req.headers, secret);
    if (attempted && !valid) {
      console.error("[whop-webhook] signature verification FAILED — rejecting.");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    if (!attempted) {
      console.warn("[whop-webhook] no signature headers present — proceeding.");
    }
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const type = typeof event.type === "string" ? event.type : "";
  if (type !== "payment.succeeded") {
    return NextResponse.json({ received: true, ignored: type || "unknown" });
  }

  const data = (event.data ?? {}) as Record<string, unknown>;
  const payment = normalizeWhopPayment(data);
  if (!payment) {
    console.error("[whop-webhook] payment.succeeded without a payment id.");
    return NextResponse.json({ received: true, error: "no payment id" });
  }

  // Already fulfilled (duplicate delivery) — ack and stop.
  const existing = await findWhopReportToken(payment.id).catch(() => null);
  if (existing && !existing.expired) {
    return NextResponse.json({ received: true, outcome: "already_done" });
  }

  let vin =
    validVin(payment.metadata.vin) || validVin(payment.metadata.VIN);

  // Second source: a fresh read of the payment (metadata may live there).
  let fresh = payment;
  if (!vin) {
    const fetched = await fetchWhopPayment(payment.id);
    if (fetched) {
      fresh = fetched;
      vin = validVin(fetched.metadata.vin) || validVin(fetched.metadata.VIN);
    }
  }

  // Fallback: match the buyer email to the newest homepage lead.
  const email = fresh.email || payment.email;
  if (!vin && email) {
    vin = await vinFromLeadEmail(email).catch(() => null);
  }

  if (!vin) {
    console.error(
      `[whop-webhook] cannot map payment ${payment.id} to a VIN — manual follow-up needed.`,
    );
    // 200 so Whop does not retry forever; this needs support follow-up.
    return NextResponse.json({ received: true, outcome: "unmapped" });
  }

  const result = await fulfillWhopPayment({
    paymentId: payment.id,
    vin,
    name: fresh.name || payment.name,
    email,
    amount: fresh.amount ?? payment.amount,
  });

  if (!result.ok) {
    console.error(
      `[whop-webhook] fulfillment failed for ${payment.id}: ${result.reason} — ${result.message}`,
    );
    return NextResponse.json({ received: true, outcome: "failed", reason: result.reason });
  }

  console.info(`[whop-webhook] fulfilled ${payment.id} for VIN ${result.vin}`);
  return NextResponse.json({ received: true, outcome: "fulfilled" });
}
