import { NextResponse } from "next/server";
import { generateQuoteForInquiry, InquiryNotFoundError } from "@/lib/quote";
import { triggerQuoteGeneration } from "@/lib/trigger-quote";

export const runtime = "nodejs";
// Quote generation calls the Claude API and can take a while — no caching.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// True on Netlify (build + runtime set these). Used to decide sync vs. async.
function isNetlify(): boolean {
  return (
    process.env.NETLIFY === "true" ||
    !!process.env.URL ||
    !!process.env.DEPLOY_PRIME_URL ||
    !!process.env.DEPLOY_URL
  );
}

// Manual "Generate quote" trigger from /admin.
//
// Quote generation takes ~1–2 min (two Claude calls + calendar lookups). That
// exceeds Netlify's synchronous-function gateway limit (~26s), which is what
// produced the 502/504s and, worse, retry-induced DUPLICATE quotes (the request
// timed out at the gateway while the work finished server-side and inserted a
// row anyway).
//
// So on Netlify we dispatch the SAME background function the form auto-trigger
// uses (15-min budget) and return 202 immediately — the caller polls /admin.
// In local dev (no Netlify functions server) we run synchronously so the button
// still works end-to-end.
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const inquiryId = params.id;

  if (isNetlify()) {
    // Fire the background function; returns once it's accepted (202). Never
    // throws — a dispatch failure leaves the inquiry quotable via a retry.
    await triggerQuoteGeneration(request, inquiryId);
    return NextResponse.json(
      {
        message: "started",
        detail:
          "Quote generation started in the background. Refresh in a minute.",
      },
      { status: 202 }
    );
  }

  // Local dev: run synchronously.
  try {
    const quote = await generateQuoteForInquiry(inquiryId);
    return NextResponse.json({ quote }, { status: 201 });
  } catch (err) {
    if (err instanceof InquiryNotFoundError) {
      return NextResponse.json(
        { error: "Inquiry not found." },
        { status: 404 }
      );
    }
    // Log the real error server-side; return a generic message to the caller.
    console.error("[api/generate-quote] failed:", err);
    return NextResponse.json(
      { error: "Quote generation failed. See server logs." },
      { status: 500 }
    );
  }
}
