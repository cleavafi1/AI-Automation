"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Manual fallback on the admin dashboard: generate a quote for an inquiry that
// doesn't have one yet (e.g. if background generation failed). Reuses the same
// manual endpoint the flow has always used.
export default function GenerateQuoteButton({
  inquiryId,
}: {
  inquiryId: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/inquiries/${inquiryId}/generate-quote`,
        { method: "POST" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Generation failed.");
        return;
      }

      // 202 = dispatched to the background function (Netlify). The quote won't
      // exist yet; tell the user and auto-refresh shortly so it appears once
      // the background run finishes (~1–2 min). 201 = generated synchronously
      // (local dev) — refresh immediately.
      if (res.status === 202) {
        setStarted(true);
        setTimeout(() => router.refresh(), 90_000);
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. See server logs.");
    } finally {
      setLoading(false);
    }
  }

  if (started) {
    return (
      <div className="text-xs text-slate-600">
        <span className="font-medium text-slate-800">
          ⏳ Generointi käynnistetty
        </span>
        <div className="mt-0.5 text-slate-500">
          Valmistuu taustalla ~1–2 min. Päivitä sivu.
        </div>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="mt-1 underline underline-offset-2 hover:text-slate-800"
        >
          Päivitä nyt
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        title="Generate a quote for this inquiry"
      >
        {loading ? "Käynnistetään…" : "Generate quote"}
      </button>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </div>
  );
}
