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
      router.refresh();
    } catch {
      setError("Something went wrong. See server logs.");
    } finally {
      setLoading(false);
    }
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
        {loading ? "Generating…" : "Generate quote"}
      </button>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </div>
  );
}
