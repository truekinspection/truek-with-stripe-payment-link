import { NextRequest, NextResponse } from "next/server";

import { findWhopReportToken } from "@/lib/fulfill-whop-payment";

export const runtime = "nodejs";

/**
 * GET /api/whop/status?payment=pay_...
 * Polled by the /whop/return page while the webhook fulfills the order.
 * Returns the report token once fulfillment has saved it.
 */
export async function GET(req: NextRequest) {
  const paymentId = req.nextUrl.searchParams.get("payment")?.trim() || "";
  if (!paymentId) {
    return NextResponse.json({ ready: false, error: "Missing payment id." }, { status: 400 });
  }

  const found = await findWhopReportToken(paymentId).catch(() => null);
  if (!found) return NextResponse.json({ ready: false });
  if (found.expired) return NextResponse.json({ ready: false, expired: true });
  return NextResponse.json({ ready: true, token: found.token, vin: found.vin });
}
