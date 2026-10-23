import { NextRequest, NextResponse } from "next/server";

import db from "@/lib/db";
import {
  createWhopCheckoutSession,
  getWhopCheckoutLink,
} from "@/lib/whop";
import { getVinValidationError, normalizeVin } from "@/lib/vin-validation";

export const runtime = "nodejs";

/**
 * POST /api/whop/checkout  { vin }
 *
 * Starts a Whop checkout for the Full Report, the Whop mirror of the old
 * Stripe Payment Link button: a checkout session is created with the VIN in
 * its metadata (so the payment.succeeded webhook can fulfill the order), and
 * the buyer is sent to Whop's hosted checkout. If session creation is not
 * available (API key permissions), we fall back to the plain checkout link —
 * fulfillment then maps the payment by buyer email via the webhook.
 */
export async function POST(req: NextRequest) {
  let vin = "";
  try {
    const body = (await req.json()) as { vin?: unknown };
    vin = typeof body.vin === "string" ? normalizeVin(body.vin) : "";
  } catch {
    return NextResponse.json({ message: "Invalid request body." }, { status: 400 });
  }

  const vinError = getVinValidationError(vin);
  if (vinError) {
    return NextResponse.json({ message: vinError }, { status: 400 });
  }

  // Attach the lead's name/email (collected by the homepage form) so the
  // payment comes back fully identified, like Stripe's customer_details.
  let name: string | undefined;
  let email: string | undefined;
  try {
    const lead = await db.report.findFirst({
      where: { vinNumber: vin },
      orderBy: { createdAt: "desc" },
      select: { firstName: true, lastName: true, email: true },
    });
    if (lead) {
      name = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || undefined;
      email = lead.email?.trim() || undefined;
    }
  } catch (e) {
    console.error("[whop/checkout] lead lookup failed:", e);
  }

  const session = await createWhopCheckoutSession({ vin, name, email });
  if (session) {
    return NextResponse.json({ url: session.url, sessionId: session.id });
  }

  const fallback = getWhopCheckoutLink();
  if (fallback) {
    return NextResponse.json({ url: fallback, fallback: true });
  }
  return NextResponse.json(
    { message: "Checkout is not configured. Please contact support." },
    { status: 500 },
  );
}
