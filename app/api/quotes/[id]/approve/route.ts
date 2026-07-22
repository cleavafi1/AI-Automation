import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  placeTentativeHold,
  SlotNoLongerFreeError,
  QuoteNotFoundError,
} from "@/lib/tentative-hold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Sets a quote's status to 'approved', then places a tentative calendar hold
// (Phase 5): a final availability re-check + a tentative event on the proposed
// slot. Called by the admin page just before send-offer; if the slot is no
// longer free (or the calendar check fails), we return a non-2xx so the client
// does NOT proceed to send.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const quoteId = params.id;

  // 1. Approve.
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("quotes")
      .update({ status: "approved" })
      .eq("id", quoteId)
      .select("id, status")
      .maybeSingle();

    if (error) {
      console.error("[api/approve] update failed:", error);
      return NextResponse.json(
        { error: "Failed to approve quote." },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: "Quote not found." }, { status: 404 });
    }
  } catch (err) {
    console.error("[api/approve] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to approve quote." },
      { status: 500 }
    );
  }

  // 2. Tentative calendar hold (final re-check + event creation).
  try {
    const hold = await placeTentativeHold(quoteId);
    // Clarification-request quotes must not book a slot — the client still sends
    // the email, but we tell the reviewer why no calendar hold was made.
    const message =
      hold.status === "needs_clarification"
        ? "Tarkennuspyyntö: pyynnöstä puuttui tietoja, joten kalenteriin EI tehty varausta. Lähetetään vain tarkennusviesti asiakkaalle."
        : hold.status === "no_slot"
          ? "Ei ehdotettua aikaa — kalenteriin ei tehty varausta."
          : "Alustava varaus tehty kalenteriin.";
    return NextResponse.json(
      { quote: { id: quoteId }, hold, message },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof QuoteNotFoundError) {
      return NextResponse.json({ error: "Quote not found." }, { status: 404 });
    }
    if (err instanceof SlotNoLongerFreeError) {
      // 409 — the client must not send. Surface a clear, actionable message.
      return NextResponse.json(
        {
          error:
            "Ehdotettu aika ei ole enää vapaa kalenterissa. Tarkista ja säädä aikaa manuaalisesti ennen lähetystä.",
        },
        { status: 409 }
      );
    }
    // Calendar unavailable / any other hold failure: don't send. The quote is
    // approved; the admin can retry once the calendar is reachable.
    console.error("[api/approve] tentative hold failed:", err);
    return NextResponse.json(
      {
        error:
          "Kalenterin tarkistus tai alustava varaus epäonnistui. Tarjousta ei lähetetty. Yritä uudelleen.",
      },
      { status: 502 }
    );
  }
}
