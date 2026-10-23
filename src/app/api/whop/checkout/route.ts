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
  // Safety guard — should not be called when provider is stripe
  if (
    process.env.PAYMENT_PROVIDER !== "whop"
  ) {
    return NextResponse.json(
      { error: "Whop checkout is not enabled." },
      { status: 400 },
    );
  }

  let body: { vin?: unknown };
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

  // Build the success redirect back to our existing report-preview flow.
  // After Whop payment, the user lands here; the webhook will have already
  // fulfilled the order and stored the token, so we redirect to /check-vin
  // with a "paid" flag so the page can poll or show a "processing" message.
  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    "https://usa.truekinspection.com"
  ).replace(/\/+$/, "");

  const redirectUrl = `${appUrl}/whop-success?vin=${encodeURIComponent(vin)}`;

  const result = await createWhopCheckout(vin, redirectUrl);

  if (!result.ok) {
    console.error("[whop/checkout] createWhopCheckout failed:", result.message);
    return NextResponse.json({ error: result.message }, { status: 502 });
  }

  return NextResponse.json({ checkoutUrl: result.checkoutUrl });
}
