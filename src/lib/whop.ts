// Whop API helpers (server-only). Uses the company Account API key
// (WHOP_API_KEY) against the Whop REST API v2.
//
// NOTE: Whop API keys have per-endpoint permissions that must be enabled in
// Whop Dashboard -> Developer for the key: `create_checkout_session` and
// `retrieve_payment`. Until those are on, session creation / payment reads
// return 401 and callers fall back gracefully.

const WHOP_API_BASE = "https://api.whop.com/api/v2";

export function getWhopPlanId(): string | null {
  const explicit = process.env.WHOP_PLAN_ID?.trim();
  if (explicit) return explicit;
  const url = process.env.NEXT_PUBLIC_WHOP_CHECKOUT_URL?.trim() || "";
  const m = url.match(/(plan_[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

export function getWhopCheckoutLink(): string {
  return process.env.NEXT_PUBLIC_WHOP_CHECKOUT_URL?.trim() || "";
}

function appOrigin(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    "https://www.truekinspection.com";
  return raw.replace(/\/+$/, "");
}

export type WhopCheckoutSession = {
  id: string;
  url: string;
};

/**
 * Creates a Whop checkout session for the plan, carrying the VIN (and the
 * lead's name/email when known) as metadata. Whop attaches that metadata to
 * the resulting payment, and the payment.succeeded webhook carries it back —
 * this is how a payment is matched to a VIN, exactly like Stripe's
 * custom_fields on the Payment Link flow.
 */
export async function createWhopCheckoutSession(params: {
  vin: string;
  name?: string;
  email?: string;
}): Promise<WhopCheckoutSession | null> {
  const apiKey = process.env.WHOP_API_KEY?.trim();
  const planId = getWhopPlanId();
  if (!apiKey || !planId) return null;

  const metadata: Record<string, string> = { vin: params.vin };
  if (params.email) metadata.email = params.email;
  if (params.name) metadata.name = params.name;

  try {
    const res = await fetch(`${WHOP_API_BASE}/checkout-sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        plan_id: planId,
        metadata,
        redirect_url: `${appOrigin()}/whop/return`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(
        `[whop] createCheckoutSession failed (${res.status}): ${text.slice(0, 300)}`,
      );
      return null;
    }
    const data = JSON.parse(text) as Record<string, unknown>;
    const id = typeof data.id === "string" ? data.id : "";
    const purchaseUrl =
      (typeof data.purchase_url === "string" && data.purchase_url) ||
      (typeof data.url === "string" && data.url) ||
      "";
    if (!id && !purchaseUrl) {
      console.error("[whop] createCheckoutSession: no id/url in response", text.slice(0, 300));
      return null;
    }
    return {
      id,
      url: purchaseUrl || `https://whop.com/checkout/${planId}`,
    };
  } catch (e) {
    console.error("[whop] createCheckoutSession error:", e);
    return null;
  }
}

export type WhopPayment = {
  id: string;
  status: string | null;
  /** Total paid, in major units (e.g. dollars), when Whop reports it. */
  amount: number | null;
  email: string | null;
  name: string | null;
  metadata: Record<string, string>;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Normalizes the many shapes Whop uses for a payment object. */
export function normalizeWhopPayment(raw: unknown): WhopPayment | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const id = str(d.id);
  if (!id) return null;

  const user = (d.user ?? {}) as Record<string, unknown>;
  const metadataRaw = (d.metadata ?? {}) as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadataRaw)) {
    if (typeof v === "string") metadata[k] = v;
  }

  let amount: number | null = null;
  for (const key of ["final_amount", "amount", "total", "amount_paid"]) {
    const v = d[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      amount = v;
      break;
    }
  }

  return {
    id,
    status: str(d.status) || str(d.payment_status),
    amount,
    email:
      str(d.email) ||
      str(d.user_email) ||
      str(d.customer_email) ||
      str(user.email) ||
      str(metadata.email),
    name: str(d.name) || str(user.name) || str(user.username) || str(metadata.name),
    metadata,
  };
}

/** Fetches one payment from Whop (needs the retrieve_payment permission). */
export async function fetchWhopPayment(paymentId: string): Promise<WhopPayment | null> {
  const apiKey = process.env.WHOP_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `${WHOP_API_BASE}/payments/${encodeURIComponent(paymentId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      console.error(
        `[whop] fetchPayment ${paymentId} failed (${res.status}): ${text.slice(0, 300)}`,
      );
      return null;
    }
    return normalizeWhopPayment(JSON.parse(text));
  } catch (e) {
    console.error("[whop] fetchPayment error:", e);
    return null;
  }
}
