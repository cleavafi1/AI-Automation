import { NextResponse } from "next/server";
import {
  sendOfferForQuote,
  QuoteNotFoundError,
  QuoteNotApprovedError,
  OfferSendError,
} from "@/lib/send-offer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Manual trigger: send the approved offer email for a quote. Rejects if the
// quote isn't 'approved'.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const quoteId = params.id;

  try {
    const { emailLog } = await sendOfferForQuote(quoteId);
    return NextResponse.json(
      {
        message: "Offer sent.",
        resend_message_id: emailLog.resend_message_id,
        email_log_id: emailLog.id,
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof QuoteNotFoundError) {
      return NextResponse.json({ error: "Quote not found." }, { status: 404 });
    }
    if (err instanceof QuoteNotApprovedError) {
      // 409 Conflict — clear message about the required state.
      return NextResponse.json(
        {
          error:
            "Quote must be approved before sending. Approve it first, then send.",
        },
        { status: 409 }
      );
    }
    if (err instanceof OfferSendError) {
      // The failure is already logged to emails_log (status 'failed') and the
      // real error printed server-side.
      return NextResponse.json(
        { error: "Email send failed. See server logs; logged to emails_log." },
        { status: 502 }
      );
    }
    console.error("[api/send-offer] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to send offer. See server logs." },
      { status: 500 }
    );
  }
}
