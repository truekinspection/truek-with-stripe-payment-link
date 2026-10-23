/**
 * Whop API helpers — server-only. Do not import from client components.
 *
 * Uses direct fetch against WHOP_API_BASE_URL so that sandbox vs production
 * is controlled entirely by env vars without any code change.
 */

function getWhopApiBase(): string {
  const raw = process.env.WHOP_API_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : "https://api.whop.com/api/v1";
}

function getWhopApiKey(): string {
  const key = process.env.WHOP_API_KEY?.trim();
  if (!key) throw new Error("WHOP_API_KEY is not configured.");
  return key;
}

export type WhopCheckoutResult =
  | { ok: true; checkoutUrl: string; id: string }
  | { ok: false; message: string };

/**
 * Creates a Whop checkout configuration for a single plan purchase.
 * Returns the hosted checkout URL to redirect the user to.
 *
 * @param vin       - The VIN the customer wants a report for (stored in metadata).
 * @param redirectUrl - Where Whop redirects after successful payment.
 */
export async function createWhopCheckout(
  vin: string,
  redirectUrl: string,
): Promise<WhopCheckoutResult> {
  const planId = process.env.WHOP_PLAN_ID?.trim();
  if (!planId) {
    return { ok: false, message: "WHOP_PLAN_ID is not configured." };
  }

  const base = getWhopApiBase();
  const key = getWhopApiKey();

  let res: Response;
  try {
    res = await fetch(`${base}/checkout_configurations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan: { plan_id: planId },
        mode: "payment",
        metadata: { vin },
        redirect_url: redirectUrl,
      }),
    });
  } catch (e) {
    console.error("[whop-client] fetch error:", e);
    return { ok: false, message: "Could not reach Whop API." };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[whop-client] non-2xx response:", res.status, text);
    return {
      ok: false,
      message: `Whop API error ${res.status}: ${text.slice(0, 200)}`,
    };
  }

  let data: { id?: string; checkout_url?: string; url?: string };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { ok: false, message: "Whop API returned invalid JSON." };
  }

  const checkoutUrl = data.checkout_url ?? data.url ?? "";
  const id = data.id ?? "";

  if (!checkoutUrl) {
    console.error("[whop-client] no checkout_url in response:", data);
    return { ok: false, message: "Whop did not return a checkout URL." };
  }

  return { ok: true, checkoutUrl, id };
}
