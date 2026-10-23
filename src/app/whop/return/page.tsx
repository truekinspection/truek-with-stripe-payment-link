"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

import { Navbar } from "@/components/navbar";
import { FooterSection } from "@/components/footer";

/**
 * Landing page after Whop checkout (redirect_url target).
 * Whop appends `payment` (pay_ id) and `status` (succeeded/failed/canceled).
 * Fulfillment itself runs from the payment.succeeded webhook — this page
 * only waits for the report token and forwards the buyer to it, exactly
 * like the Stripe flow landed on /report-preview after payment.
 */
function WhopReturnInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paymentId = searchParams.get("payment") || "";
  const status = (searchParams.get("status") || "").toLowerCase();

  const [state, setState] = useState<"waiting" | "failed" | "timeout">(
    status && status !== "succeeded" && status !== "success"
      ? "failed"
      : "waiting",
  );
  const tries = useRef(0);

  useEffect(() => {
    if (state !== "waiting") return;
    if (!paymentId) {
      setState("timeout");
      return;
    }
    // Stripe-flow style: ask the server to verify + fulfill this payment
    // right now, then poll for the report token below.
    void fetch("/api/whop/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentId }),
    }).catch(() => {});
    const timer = setInterval(async () => {
      tries.current += 1;
      try {
        const res = await fetch(
          `/api/whop/status?payment=${encodeURIComponent(paymentId)}`,
        );
        const data = (await res.json()) as {
          ready?: boolean;
          token?: string;
          vin?: string;
        };
        if (data.ready && data.token) {
          clearInterval(timer);
          router.replace(
            `/report-preview?token=${encodeURIComponent(data.token)}&vin=${encodeURIComponent(data.vin || "")}`,
          );
          return;
        }
      } catch {
        // keep polling
      }
      if (tries.current >= 40) {
        clearInterval(timer);
        setState("timeout");
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [paymentId, router, state]);

  return (
      <section className="mx-auto max-w-2xl px-4 py-24 text-center">
        {state === "waiting" && (
          <>
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-custom_red" />
            <h1 className="mt-6 text-3xl font-bold text-gray-900">
              Payment received — preparing your report
            </h1>
            <p className="mt-3 text-gray-600">
              We are generating your full vehicle history report now. This page
              will open it automatically in a few seconds. A copy is also being
              sent to your email.
            </p>
          </>
        )}
        {state === "timeout" && (
          <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-green-600" />
            <h1 className="mt-6 text-3xl font-bold text-gray-900">
              Payment received
            </h1>
            <p className="mt-3 text-gray-600">
              Your report is being prepared and a link is being sent to your
              email. If it does not arrive within a few minutes, please contact
              support with your payment reference
              {paymentId ? (
                <>
                  : <span className="font-mono text-sm">{paymentId}</span>
                </>
              ) : (
                "."
              )}
            </p>
          </>
        )}
        {state === "failed" && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-red-500" />
            <h1 className="mt-6 text-3xl font-bold text-gray-900">
              Payment not completed
            </h1>
            <p className="mt-3 text-gray-600">
              Your payment did not go through, so no report was generated and
              you were not charged for a report. You can try again from the
              checkout page.
            </p>
            <Link
              href="/check-vin"
              className="mt-6 inline-block rounded-xl bg-custom_red px-6 py-3 font-semibold text-white"
            >
              Back to checkout
            </Link>
          </>
        )}
      </section>
  );
}

export default function WhopReturnPage() {
  return (
    <main className="min-h-screen bg-white">
      <Navbar />
      <Suspense
        fallback={
          <section className="mx-auto max-w-2xl px-4 py-24 text-center">
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-custom_red" />
          </section>
        }
      >
        <WhopReturnInner />
      </Suspense>
      <FooterSection />
    </main>
  );
}
