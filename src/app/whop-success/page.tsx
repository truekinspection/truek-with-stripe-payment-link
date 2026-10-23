"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Navbar } from "@/components/navbar";
import { FooterSection } from "@/components/footer";
import { Button } from "@/components/ui/button";

/**
 * /whop-success
 *
 * Landing page after a successful Whop payment redirect.
 * Whop redirects here with ?vin=<VIN> (set in the checkout redirect_url).
 *
 * We poll /api/store-report?... — actually we just wait a few seconds for the
 * webhook to fire, then redirect the user to /account-activity where they can
 * find their token once fulfilled. This page is only shown when
 * PAYMENT_PROVIDER=whop.
 */
export default function WhopSuccessPage() {
  const router = useRouter();
  const params = useSearchParams();
  const vin = params.get("vin") ?? "";

  const [status, setStatus] = useState<"waiting" | "done" | "timeout">(
    "waiting",
  );

  useEffect(() => {
    // Webhook usually fires within a few seconds. We wait up to 30 s then
    // redirect to account-activity so the user can check their report there.
    let attempts = 0;
    const maxAttempts = 10; // 10 × 3 s = 30 s

    const interval = setInterval(() => {
      attempts++;
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        setStatus("timeout");
      }
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (status === "timeout") {
      // Redirect to account-activity — report may appear once webhook fires
      router.push("/account-activity");
    }
  }, [status, router]);

  return (
    <main className="max-w-[1920px] mx-auto relative overflow-hidden min-h-screen flex flex-col">
      <Navbar />
      <div className="flex-1 mt-24 max-w-2xl mx-auto px-4 py-10 w-full flex items-center justify-center">
        <div className="text-center space-y-6 p-8 rounded-2xl border border-green-200 bg-green-50/90 shadow-sm w-full max-w-lg">
          {status === "waiting" ? (
            <>
              <Loader2 className="h-12 w-12 text-green-600 animate-spin mx-auto" />
              <h1 className="text-2xl font-bold text-gray-900">
                Payment confirmed! Preparing your report…
              </h1>
              {vin && (
                <p className="text-gray-600 text-sm">
                  VIN: <span className="font-mono font-semibold">{vin}</span>
                </p>
              )}
              <p className="text-gray-500 text-sm">
                Your full ClearVIN report is being fetched and emailed to you.
                This page will redirect automatically.
              </p>
            </>
          ) : status === "done" ? (
            <>
              <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto" />
              <h1 className="text-2xl font-bold text-gray-900">
                Report ready!
              </h1>
              <p className="text-gray-600 text-sm">Redirecting you now…</p>
            </>
          ) : (
            <>
              <AlertTriangle className="h-10 w-10 text-amber-600 mx-auto" />
              <h1 className="text-2xl font-bold text-gray-900">
                Processing your order…
              </h1>
              <p className="text-gray-600 text-sm">
                Your payment was received. We&apos;re still preparing your
                report — it will be emailed to you shortly.
              </p>
              <Button
                className="bg-custom_red hover:bg-red-700 text-white"
                onClick={() => router.push("/account-activity")}
              >
                View My Orders
              </Button>
            </>
          )}
        </div>
      </div>
      <FooterSection />
    </main>
  );
}
