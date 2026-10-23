import { NextRequest, NextResponse } from "next/server";

import { fulfillWhopPayment } from "@/lib/fulfill-whop-payment";
import { fetchWhopPayment } from "@/lib/whop";

export const runtime = "nodejs";

/**
 * POST /api/whop/manual-fulfill   header: x-fulfill-secret: <FULFILL_SECRET>
 * Body: { paymentId: string, vin?: string }
 *
 * Support/recovery tool: fulfills a Whop payment that arrived without a
 * mappable webhook (e.g. a purchase made through the plain checkout link
 * before checkout sessions carried metadata). Verifies the payment with
 * Whop first, then runs the exact same fulfillment as the webhook.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.FULFILL_SECRET?.trim();
  if (!secret || req.headers.get("x-fulfill-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let paymentId = "";
  let vinOverride = "";
  try {
    const body = (await req.json()) as { paymentId?: unknown; vin?: unknown };
    paymentId = typeof body.paymentId === "string" ? body.paymentId.trim() : "";
    vinOverride = typeof body.vin === "string" ? body.vin.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!paymentId) {
    return NextResponse.json({ error: "Missing paymentId." }, { status: 400 });
  }

  const payment = await fetchWhopPayment(paymentId);
  if (!payment) {
    return NextResponse.json(
      { error: "Could not read this payment from Whop (check API key permissions)." },
      { status: 502 },
    );
  }
  const status = (payment.status || "").toLowerCase();
  if (status && !["succeeded", "paid", "completed", "success"].includes(status)) {
    return NextResponse.json(
      { error: `Payment is not completed (status: ${payment.status}).` },
      { status: 400 },
    );
  }

  const result = await fulfillWhopPayment({
    paymentId,
    vin: vinOverride || payment.metadata.vin || "",
    name: payment.name,
    email: payment.email,
    amount: payment.amount,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, reason: result.reason },
      { status: 400 },
    );
  }

  const origin = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    ""
  ).replace(/\/+$/, "");
  return NextResponse.json({
    ok: true,
    vin: result.vin,
    reportUrl: `${origin}/report-preview?token=${encodeURIComponent(result.token)}&vin=${encodeURIComponent(result.vin)}`,
  });
}
