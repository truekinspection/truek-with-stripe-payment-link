import { NextRequest, NextResponse } from "next/server";

import { fulfillWhopPayment } from "@/lib/fulfill-whop-payment";
import { fetchWhopPayment } from "@/lib/whop";

export const runtime = "nodejs";

/**
 * POST /api/whop/confirm  { paymentId }
 *
 * Called by the /whop/return page right after checkout — the Whop twin of
 * the Stripe flow's return step: verify the payment with Whop, then fulfill
 * it on the spot (ClearVin report + emails) so the buyer lands straight on
 * the report. The payment.succeeded webhook stays as the backup for buyers
 * who close the browser before returning.
 */
export async function POST(req: NextRequest) {
  let paymentId = "";
  try {
    const body = (await req.json()) as { paymentId?: unknown };
    if (typeof body.paymentId === "string") paymentId = body.paymentId.trim();
  } catch {
    /* fall through */
  }
  if (!paymentId) {
    return NextResponse.json({ ok: false, error: "Missing paymentId." }, { status: 400 });
  }

  const payment = await fetchWhopPayment(paymentId);
  if (!payment) {
    // Whop API cannot read the payment yet (key permissions) — the webhook
    // or support path will fulfill it; the return page keeps waiting.
    return NextResponse.json({ ok: false, pending: true });
  }
  const status = (payment.status || "").toLowerCase();
  if (status && !["succeeded", "paid", "completed", "success"].includes(status)) {
    return NextResponse.json({ ok: false, pending: true });
  }

  const result = await fulfillWhopPayment({
    paymentId,
    vin: payment.metadata.vin || "",
    name: payment.name,
    email: payment.email,
    amount: payment.amount,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, pending: true, reason: result.reason });
  }
  return NextResponse.json({ ok: true, vin: result.vin });
}
