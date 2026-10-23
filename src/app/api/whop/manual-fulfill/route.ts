import { NextRequest, NextResponse } from "next/server";

import { fulfillWhopPayment } from "@/lib/fulfill-whop-payment";
import { fetchWhopPayment } from "@/lib/whop";

export const runtime = "nodejs";

/**
 * /api/whop/manual-fulfill   header: x-fulfill-secret: <FULFILL_SECRET>
 * POST body or GET query: { paymentId, vin?, email?, name?, amount? }
 *
 * Support/recovery tool: fulfills a Whop payment that arrived without a
 * mappable webhook (e.g. a purchase made through the plain checkout link
 * before checkout sessions carried metadata). It first tries to verify the
 * payment with Whop; when the API key cannot read payments yet, the
 * secret-holding operator may supply the order details explicitly (the
 * payment is then fulfilled on the operator's evidence, e.g. the buyer's
 * Whop success receipt) and the delivery is logged as operator-provided.
 * Either way it runs the exact same fulfillment as the webhook.
 */
async function runFulfill(params: {
  paymentId: string;
  vin?: string;
  email?: string;
  name?: string;
  amount?: number;
}): Promise<NextResponse> {
  const { paymentId } = params;
  if (!paymentId) {
    return NextResponse.json({ error: "Missing paymentId." }, { status: 400 });
  }

  const payment = await fetchWhopPayment(paymentId);
  if (payment) {
    const status = (payment.status || "").toLowerCase();
    if (status && !["succeeded", "paid", "completed", "success"].includes(status)) {
      return NextResponse.json(
        { error: `Payment is not completed (status: ${payment.status}).` },
        { status: 400 },
      );
    }
    const result = await fulfillWhopPayment({
      paymentId,
      vin: params.vin || payment.metadata.vin || "",
      name: params.name || payment.name,
      email: params.email || payment.email,
      amount: params.amount ?? payment.amount,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, verified: "whop-api", vin: result.vin, token: result.token });
  }

  // Whop API could not read the payment (permissions). Only the secret
  // holder can reach this route, so explicit order details are accepted
  // on their evidence and clearly logged.
  if (!params.vin || !params.email) {
    return NextResponse.json(
      {
        error:
          "Could not read this payment from Whop, and no explicit vin/email were provided for operator-verified fulfillment.",
      },
      { status: 502 },
    );
  }
  console.warn(
    `[manual-fulfill] fulfilling ${paymentId} on OPERATOR-PROVIDED data (Whop API read unavailable).`,
  );
  const result = await fulfillWhopPayment({
    paymentId,
    vin: params.vin,
    name: params.name,
    email: params.email,
    amount: params.amount,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, reason: result.reason },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    verified: "operator-provided",
    vin: result.vin,
    token: result.token,
  });
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.FULFILL_SECRET?.trim();
  return !!secret && req.headers.get("x-fulfill-secret") === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await req.json()) as Record<string, unknown>;
    return runFulfill({
      paymentId: typeof body.paymentId === "string" ? body.paymentId.trim() : "",
      vin: typeof body.vin === "string" ? body.vin.trim() : undefined,
      email: typeof body.email === "string" ? body.email.trim() : undefined,
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      amount: typeof body.amount === "number" ? body.amount : undefined,
    });
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const q = req.nextUrl.searchParams;
  const amountRaw = q.get("amount");
  return runFulfill({
    paymentId: q.get("paymentId")?.trim() || "",
    vin: q.get("vin")?.trim() || undefined,
    email: q.get("email")?.trim() || undefined,
    name: q.get("name")?.trim() || undefined,
    amount: amountRaw ? Number(amountRaw) || undefined : undefined,
  });
}
