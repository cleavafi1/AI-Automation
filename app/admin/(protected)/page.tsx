import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  serviceLabel,
  sizeLabel,
  frequencyLabel,
} from "@/lib/constants";
import type { Inquiry, Quote, EmailLog } from "@/lib/types";
import ApproveSendButton from "@/components/ApproveSendButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type QuoteWithInquiry = Quote & { inquiries: Inquiry | null };
type Filter = "all" | "flagged" | "sent";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "flagged", label: "Flagged only" },
  { key: "sent", label: "Sent" },
];

// Effective status for the badge: a successful send wins, then a failed send,
// otherwise the quote's own workflow status.
type DisplayStatus = "draft" | "approved" | "rejected" | "sent" | "failed";

function badgeClasses(status: DisplayStatus): string {
  switch (status) {
    case "sent":
      return "bg-green-100 text-green-800";
    case "approved":
      return "bg-blue-100 text-blue-800";
    case "failed":
      return "bg-red-100 text-red-800";
    case "rejected":
      return "bg-red-50 text-red-700";
    case "draft":
    default:
      return "bg-slate-100 text-slate-700";
  }
}

export default async function AdminQuotesPage({
  searchParams,
}: {
  searchParams: { filter?: string };
}) {
  const filter: Filter =
    searchParams.filter === "flagged" || searchParams.filter === "sent"
      ? searchParams.filter
      : "all";

  const supabase = getSupabaseAdmin();
  const { data, error, count } = await supabase
    .from("quotes")
    .select("*, inquiries(*)", { count: "exact" })
    .order("created_at", { ascending: false });

  const quotes = (data ?? []) as QuoteWithInquiry[];
  const totalCount = count ?? quotes.length;
  const countMismatch = totalCount !== quotes.length;

  // Email logs → send status per quote.
  const quoteIds = quotes.map((q) => q.id);
  const logsResult = quoteIds.length
    ? await supabase
        .from("emails_log")
        .select("*")
        .in("quote_id", quoteIds)
        .order("created_at", { ascending: false })
    : { data: [] as EmailLog[], error: null };
  if (logsResult.error) {
    console.error(
      "[admin] emails_log query failed:",
      logsResult.error.message
    );
  }
  const logs = (logsResult.data ?? []) as EmailLog[];

  const latestLogByQuote = new Map<string, EmailLog>();
  const sentOkByQuote = new Set<string>();
  for (const log of logs) {
    if (!log.quote_id) continue;
    if (!latestLogByQuote.has(log.quote_id)) {
      latestLogByQuote.set(log.quote_id, log);
    }
    if (log.status === "sent") sentOkByQuote.add(log.quote_id);
  }

  function displayStatus(q: QuoteWithInquiry): DisplayStatus {
    if (sentOkByQuote.has(q.id)) return "sent";
    if (latestLogByQuote.get(q.id)?.status === "failed") return "failed";
    return q.status as DisplayStatus;
  }

  const visible = quotes.filter((q) => {
    if (filter === "flagged") return q.is_flagged;
    if (filter === "sent") return sentOkByQuote.has(q.id);
    return true;
  });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold text-slate-900">Quotes</h1>
        <p className="text-sm text-slate-500">
          Showing {visible.length} of {totalCount} quote
          {totalCount === 1 ? "" : "s"}
        </p>
      </div>

      {/* Filter tabs */}
      <div className="mt-4 flex gap-1 border-b border-slate-200">
        {FILTERS.map((f) => {
          const active = f.key === filter;
          const href = f.key === "all" ? "/admin" : `/admin?filter=${f.key}`;
          return (
            <Link
              key={f.key}
              href={href}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                active
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load quotes: {error.message}
        </p>
      )}

      {countMismatch && (
        <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ⚠ Only {quotes.length} of {totalCount} quotes were returned — the
          query is capping rows. Check for a limit / pagination default.
        </p>
      )}

      {logsResult.error && (
        <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ⚠ Could not load email send status: {logsResult.error.message}
        </p>
      )}

      {visible.length === 0 && !error && (
        <p className="mt-6 text-sm text-slate-500">
          {quotes.length === 0
            ? "No quotes yet."
            : "No quotes match this filter."}
        </p>
      )}

      {/* Cards */}
      <div className="mt-5 space-y-3">
        {visible.map((q) => {
          const inq = q.inquiries;
          const status = displayStatus(q);
          const latestLog = latestLogByQuote.get(q.id) ?? null;
          const sentOk = sentOkByQuote.has(q.id);

          return (
            <article
              key={q.id}
              className={`rounded-xl border bg-white shadow-sm ${
                q.is_flagged
                  ? "border-slate-200 border-l-4 border-l-amber-400"
                  : "border-slate-200"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-4 p-4">
                {/* Left: who + what */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate font-semibold text-slate-900">
                      {inq ? inq.name : "(inquiry deleted)"}
                    </h2>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClasses(
                        status
                      )}`}
                    >
                      {status}
                    </span>
                    {q.is_flagged && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                        ⚑ Flagged
                      </span>
                    )}
                  </div>
                  {inq && (
                    <p className="mt-1 text-sm text-slate-600">
                      {serviceLabel(inq.service_type)} ·{" "}
                      {sizeLabel(inq.property_size)} ·{" "}
                      {frequencyLabel(inq.frequency)} · {inq.postal_code}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-slate-400">
                    {new Date(q.created_at).toLocaleString("fi-FI")}
                  </p>
                </div>

                {/* Right: price + action */}
                <div className="flex flex-col items-end gap-2">
                  <div className="text-right">
                    <div className="text-lg font-semibold text-slate-900">
                      {q.estimated_price_eur != null
                        ? `${q.estimated_price_eur} €`
                        : "—"}
                    </div>
                  </div>
                  <ApproveSendButton
                    quoteId={q.id}
                    isFlagged={q.is_flagged}
                    sentOk={sentOk}
                  />
                  {latestLog && (
                    <div className="text-right text-xs text-slate-500">
                      {latestLog.status === "sent" ? (
                        <span>
                          → {latestLog.to_address}
                          <br />
                          {new Date(latestLog.created_at).toLocaleString(
                            "fi-FI"
                          )}
                        </span>
                      ) : (
                        <span className="text-red-600">
                          ✗ Last attempt failed
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Expandable detail */}
              <details className="group border-t border-slate-100">
                <summary className="cursor-pointer list-none px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50">
                  <span className="group-open:hidden">▸ View full quote</span>
                  <span className="hidden group-open:inline">
                    ▾ Hide details
                  </span>
                </summary>
                <div className="grid gap-5 px-4 pb-4 pt-1 md:grid-cols-2">
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Drafted quote
                    </h3>
                    <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-700">
                      {q.drafted_text}
                    </p>
                    {q.is_flagged && q.flag_reason && (
                      <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        <span className="font-semibold">Flag reason: </span>
                        {q.flag_reason}
                      </div>
                    )}
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Inquiry
                    </h3>
                    {inq ? (
                      <dl className="mt-1.5 space-y-1 text-sm">
                        <Row label="Email" value={inq.email} />
                        <Row label="Phone" value={inq.phone} />
                        <Row
                          label="Service"
                          value={serviceLabel(inq.service_type)}
                        />
                        <Row
                          label="Size"
                          value={sizeLabel(inq.property_size)}
                        />
                        <Row
                          label="Frequency"
                          value={frequencyLabel(inq.frequency)}
                        />
                        <Row
                          label="Postal"
                          value={`${inq.postal_code}${
                            inq.city ? ` · ${inq.city}` : ""
                          }`}
                        />
                        <Row label="Notes" value={inq.notes ?? "—"} />
                      </dl>
                    ) : (
                      <p className="mt-1.5 text-sm text-slate-400">
                        Inquiry no longer exists.
                      </p>
                    )}
                  </div>
                </div>
              </details>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-slate-400">{label}</dt>
      <dd className="min-w-0 break-words text-slate-700">{value}</dd>
    </div>
  );
}
