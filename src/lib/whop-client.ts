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
  email?: string,
): Promise<WhopCheckoutResult> {
  const planId = process.env.WHOP_PLAN_ID?.trim();
  if (!planId) {
    return { ok: false, message: "WHOP_PLAN_ID is not configured." };
  }

  const base = getWhopApiBase();
  const key = getWhopApiKey();

  // Helper to build a direct checkout URL as a fallback if API endpoint returns 403 or non-2xx
  const buildDirectUrl = () => {
    const isSandbox = base.includes("sandbox");
    const domain = isSandbox ? "https://sandbox.whop.com" : "https://whop.com";
    const u = new URL(`${domain}/checkout/${planId}`);
    if (redirectUrl) u.searchParams.set("redirect_url", redirectUrl);
    if (email) u.searchParams.set("email", email);
    return u.toString();
  };

  try {
    const res = await fetch(`${base}/checkout_configurations`, {
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

    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        id?: string;
        checkout_url?: string;
        url?: string;
      } | null;
      const checkoutUrl = data?.checkout_url ?? data?.url;
      if (checkoutUrl) {
        return { ok: true, checkoutUrl, id: data?.id ?? planId };
      }
    }
  } catch (e) {
    console.warn("[whop-client] checkout configuration API call failed, falling back to direct URL:", e);
  }

  // Graceful fallback to direct Whop plan checkout
  return { ok: true, checkoutUrl: buildDirectUrl(), id: planId };
}
