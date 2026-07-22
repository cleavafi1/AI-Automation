import { getSupabaseAdmin } from "./supabase";
import { placeTentativeHold, type HoldResult } from "./tentative-hold";
import { sendOfferForQuote, type SendOfferResult } from "./send-offer";

// The exact "Approve & send" sequence used by /admin, factored out so the
// Telegram Approve button reuses it verbatim instead of duplicating it:
//   1. mark the quote 'approved'
//   2. final calendar re-check + tentative hold (throws SlotNoLongerFreeError)
//   3. send the offer email to the customer
//
// (The /admin API routes run steps 1+2 in the approve route and step 3 in the
// send-offer route; the underlying functions — placeTentativeHold,
// sendOfferForQuote — are the same ones composed here.)

export type ApproveSendResult = {
  hold: HoldResult;
  send: SendOfferResult;
};

export async function approveAndSend(
  quoteId: string
): Promise<ApproveSendResult> {
  const supabase = getSupabaseAdmin();

  // 1. Approve.
  const { data: updated, error: updateError } = await supabase
    .from("quotes")
    .update({ status: "approved" })
    .eq("id", quoteId)
    .select("id")
    .maybeSingle();
  if (updateError) {
    throw new Error(`Failed to approve quote: ${updateError.message}`);
  }
  if (!updated) {
    throw new Error(`Quote not found: ${quoteId}`);
  }

  // 2. Final availability re-check + tentative hold. Throws SlotNoLongerFreeError
  //    if the slot filled up — the caller must NOT send in that case.
  const hold = await placeTentativeHold(quoteId);

  // 3. Send the offer email (requires status 'approved', set above).
  const send = await sendOfferForQuote(quoteId);

  return { hold, send };
}
