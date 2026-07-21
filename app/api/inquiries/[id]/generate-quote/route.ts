import { NextResponse } from "next/server";
import { generateQuoteForInquiry, InquiryNotFoundError } from "@/lib/quote";

export const runtime = "nodejs";
// Quote generation calls the Claude API and can take a while — no caching.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Manual trigger used for testing. NOT called automatically on form submit.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const inquiryId = params.id;

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
