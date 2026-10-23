import { NextRequest, NextResponse } from "next/server";
import { createWhopCheckout } from "@/lib/whop-client";
import { getVinValidationError, normalizeVin } from "@/lib/vin-validation";

/**
 * POST /api/whop/checkout
 *
 * Body: { vin: string }
 *
 * Creates a Whop checkout configuration for the given VIN and returns
 * { checkoutUrl } so the client can redirect the user.
 *
 * Only active when PAYMENT_PROVIDER=whop; the frontend already guards this,
 * but we also reject here for safety.
 */
export async function POST(req: NextRequest) {
  const provider = process.env.PAYMENT_PROVIDER?.trim() || "whop";
  if (provider !== "whop") {
    return NextResponse.json(
      { error: "Whop checkout is not enabled." },
      { status: 400 },
    );
  }

  let body: { vin?: unknown; email?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rawVin = typeof body.vin === "string" ? body.vin.trim() : "";
  if (!rawVin) {
    return NextResponse.json({ error: "vin is required." }, { status: 400 });
  }

  const vin = normalizeVin(rawVin);
  const vinError = getVinValidationError(vin);
  if (vinError) {
    return NextResponse.json({ error: vinError }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : undefined;

  // Build the success redirect back to our existing report-preview flow.
  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    "https://usa.truekinspection.com"
  ).replace(/\/+$/, "");

  const redirectUrl = `${appUrl}/whop-success?vin=${encodeURIComponent(vin)}`;

  const result = await createWhopCheckout(vin, redirectUrl, email);

  if (!result.ok) {
    console.error("[whop/checkout] createWhopCheckout failed:", result.message);
    return NextResponse.json({ error: result.message }, { status: 502 });
  }

  return NextResponse.json({ checkoutUrl: result.checkoutUrl });
}
