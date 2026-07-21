"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Per-row action on the internal quotes page: approve the quote, then send the
// offer email. Flagged quotes get a distinct look + an explicit confirm step.
export default function ApproveSendButton({
  quoteId,
  isFlagged,
  sentOk,
}: {
  quoteId: string;
  isFlagged: boolean;
  sentOk: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);

    if (isFlagged) {
      const ok = window.confirm(
        "Tämä tarjous on merkitty tarkistettavaksi (⚑). Hyväksytäänkö ja lähetetäänkö silti asiakkaalle?"
      );
      if (!ok) return;
    }

    setLoading(true);
    try {
      // 1. Approve.
      const approveRes = await fetch(`/api/quotes/${quoteId}/approve`, {
        method: "POST",
      });
      if (!approveRes.ok) {
        const data = await approveRes.json().catch(() => null);
        setError(data?.error ?? "Approve failed.");
        return;
      }

      // 2. Send the offer.
      const sendRes = await fetch(`/api/quotes/${quoteId}/send-offer`, {
        method: "POST",
      });
      const sendData = await sendRes.json().catch(() => null);
      if (!sendRes.ok) {
        setError(sendData?.error ?? "Send failed.");
        return;
      }

      router.refresh();
    } catch {
      setError("Something went wrong. See server logs.");
    } finally {
      setLoading(false);
    }
  }

  if (sentOk) {
    return (
      <div className="text-xs">
        <span className="font-semibold text-green-700">✓ Sent</span>
        <button
          type="button"
          onClick={handleClick}
          disabled={loading}
          className="ml-2 text-slate-400 underline underline-offset-2 hover:text-slate-600 disabled:opacity-50"
        >
          {loading ? "…" : "resend"}
        </button>
        {error && <div className="mt-1 text-red-600">{error}</div>}
      </div>
    );
  }

  const base =
    "rounded px-3 py-1.5 text-xs font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60";
  const color = isFlagged
    ? "bg-amber-600 hover:bg-amber-700"
    : "bg-slate-800 hover:bg-slate-700";

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className={`${base} ${color}`}
        title={
          isFlagged
            ? "Flagged quote — you'll be asked to confirm"
            : "Approve and send the offer email"
        }
      >
        {loading
          ? "Sending…"
          : isFlagged
            ? "⚑ Approve & send"
            : "Approve & send"}
      </button>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </div>
  );
}
