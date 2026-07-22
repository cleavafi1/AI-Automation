import { getSupabaseAdmin } from "./supabase";
import { isSlotStillFree, type Slot } from "./booking";
import {
  createTaggedEvent,
  getEventById,
  updateEvent,
  deleteEvent,
} from "./calendar";
import { normalizeHHMM } from "./timezone";
import { serviceLabel } from "./constants";
import type { Inquiry, Quote } from "./types";

// Thrown when the proposed slot filled up between quote generation and approval.
export class SlotNoLongerFreeError extends Error {
  constructor() {
    super("Proposed slot is no longer free.");
    this.name = "SlotNoLongerFreeError";
  }
}

export class QuoteNotFoundError extends Error {
  constructor(id: string) {
    super(`Quote not found: ${id}`);
    this.name = "QuoteNotFoundError";
  }
}

export type HoldResult =
  | { status: "no_slot" } // quote has no proposed appointment — nothing to hold
  | { status: "needs_clarification" } // inquiry incomplete — no booking allowed
  | { status: "already_held"; eventId: string } // idempotent: already placed
  | { status: "held"; eventId: string };

/**
 * Final availability re-check + tentative calendar hold, run at approval time
 * (a slot could fill between quote generation and approval). If the quote has a
 * proposed slot and no hold yet, re-check the calendar; if still free, create a
 * tentative event tagged source: cleava-agent and store its id. Throws
 * SlotNoLongerFreeError if the slot is taken (caller must NOT send).
 * Idempotent: if a hold already exists, returns it without creating another.
 */
export async function placeTentativeHold(quoteId: string): Promise<HoldResult> {
  const supabase = getSupabaseAdmin();

  const { data: quote, error: quoteError } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  if (quoteError) {
    throw new Error(`Failed to load quote: ${quoteError.message}`);
  }
  if (!quote) throw new QuoteNotFoundError(quoteId);
  const typedQuote = quote as Quote;

  // Load the inquiry up front — needed for the clarification guard below, and
  // later for the event title/location.
  const { data: inquiry, error: inquiryError } = await supabase
    .from("inquiries")
    .select("*")
    .eq("id", typedQuote.inquiry_id)
    .maybeSingle();
  if (inquiryError) {
    throw new Error(`Failed to load inquiry: ${inquiryError.message}`);
  }
  const typedInquiry = (inquiry ?? null) as Inquiry | null;

  // HARD GUARD: an inquiry still missing critical details (needs_clarification)
  // must NEVER reserve a slot or create a calendar event, even if a tentative
  // time was proposed at generation. Approving such a quote only sends the
  // clarification-request email. Return early so no hold is placed.
  if (typedInquiry?.needs_clarification) {
    return { status: "needs_clarification" };
  }

  // Idempotent — don't create a second event on resend/retry.
  if (typedQuote.calendar_event_id) {
    return { status: "already_held", eventId: typedQuote.calendar_event_id };
  }

  // No proposed appointment (e.g. quote-only service, or calendar was down at
  // generation) → nothing to hold; the caller proceeds to send.
  if (
    !typedQuote.proposed_date ||
    !typedQuote.proposed_start_time ||
    !typedQuote.proposed_end_time
  ) {
    return { status: "no_slot" };
  }

  const date = typedQuote.proposed_date;
  const startTime = normalizeHHMM(typedQuote.proposed_start_time);
  const endTime = normalizeHHMM(typedQuote.proposed_end_time);
  if (!startTime || !endTime) {
    throw new Error(
      `Quote ${quoteId} has malformed proposed times: ${typedQuote.proposed_start_time} / ${typedQuote.proposed_end_time}`
    );
  }

  // Final re-check against the live calendar.
  const free = await isSlotStillFree({ date, startTime, endTime });
  if (!free) {
    throw new SlotNoLongerFreeError();
  }

  // Create the tentative event, tagged so future counting is exact.
  const name = typedInquiry?.name ?? "asiakas";
  const service = serviceLabel(typedInquiry?.service_type ?? null);
  const eventId = await createTaggedEvent({
    summary: `Tentative – ${name} – Quote awaiting acceptance`,
    description: [
      `Alustava (tentative) varaus — odottaa asiakkaan vahvistusta.`,
      `Palvelu: ${service}`,
      typedInquiry?.property_size_m2 != null
        ? `Koko: ${typedInquiry.property_size_m2} m²`
        : null,
      typedInquiry?.postal_code || typedInquiry?.city
        ? `Sijainti: ${[typedInquiry?.postal_code, typedInquiry?.city]
            .filter(Boolean)
            .join(" ")}`
        : null,
      `Quote ID: ${quoteId}`,
    ]
      .filter(Boolean)
      .join("\n"),
    date,
    startTime,
    endTime,
  });

  const { error: updateError } = await supabase
    .from("quotes")
    .update({ calendar_event_id: eventId })
    .eq("id", quoteId);
  if (updateError) {
    // The event exists but we couldn't record its id — surface loudly so it can
    // be reconciled (otherwise a retry would create a duplicate).
    throw new Error(
      `Tentative event ${eventId} created but failed to save id on quote ${quoteId}: ${updateError.message}`
    );
  }

  return { status: "held", eventId };
}

async function loadQuoteAndInquiry(
  quoteId: string
): Promise<{ quote: Quote; inquiry: Inquiry | null }> {
  const supabase = getSupabaseAdmin();
  const { data: quote, error } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load quote: ${error.message}`);
  if (!quote) throw new QuoteNotFoundError(quoteId);
  const typedQuote = quote as Quote;
  const { data: inq } = await supabase
    .from("inquiries")
    .select("*")
    .eq("id", typedQuote.inquiry_id)
    .maybeSingle();
  return { quote: typedQuote, inquiry: (inq ?? null) as Inquiry | null };
}

export type ConfirmResult =
  | { status: "confirmed"; eventId: string }
  | { status: "confirmed_no_event" } // nothing to book (no proposed slot)
  | { status: "already_confirmed" };

/**
 * Convert a tentative hold into a CONFIRMED booking (Phase 7, on an approved
 * acceptance reply). Does a final availability re-check first — ignoring our own
 * tentative event so it doesn't count against its own slot — then rewrites the
 * event title to "Confirmed". Throws SlotNoLongerFreeError if a conflicting
 * booking appeared in the meantime.
 */
export async function confirmBooking(quoteId: string): Promise<ConfirmResult> {
  const supabase = getSupabaseAdmin();
  const { quote, inquiry } = await loadQuoteAndInquiry(quoteId);

  if (quote.status === "confirmed") return { status: "already_confirmed" };

  const date = quote.proposed_date;
  const startTime = quote.proposed_start_time
    ? normalizeHHMM(quote.proposed_start_time)
    : null;
  const endTime = quote.proposed_end_time
    ? normalizeHHMM(quote.proposed_end_time)
    : null;

  // No concrete slot to confirm — just mark the quote confirmed.
  if (!date || !startTime || !endTime) {
    await supabase.from("quotes").update({ status: "confirmed" }).eq("id", quoteId);
    return { status: "confirmed_no_event" };
  }

  const name = inquiry?.name ?? "asiakas";
  const service = serviceLabel(inquiry?.service_type ?? null);
  const summary = `Confirmed – ${name} – ${service}`;
  const description = [
    "Vahvistettu varaus (asiakas hyväksynyt).",
    `Palvelu: ${service}`,
    inquiry?.property_size_m2 != null ? `Koko: ${inquiry.property_size_m2} m²` : null,
    `Quote ID: ${quoteId}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (quote.calendar_event_id) {
    // Final re-check ignoring our own tentative event; still exists → confirm it.
    const free = await isSlotStillFree({
      date,
      startTime,
      endTime,
      ignoreEventId: quote.calendar_event_id,
    });
    if (!free) throw new SlotNoLongerFreeError();
    const existing = await getEventById(quote.calendar_event_id);
    if (existing) {
      await updateEvent(quote.calendar_event_id, { summary, description });
      await supabase.from("quotes").update({ status: "confirmed" }).eq("id", quoteId);
      return { status: "confirmed", eventId: quote.calendar_event_id };
    }
    // The tentative event vanished — fall through to create a fresh confirmed one.
  }

  // No existing hold: re-check the slot is free, then create the confirmed event.
  const free = await isSlotStillFree({ date, startTime, endTime });
  if (!free) throw new SlotNoLongerFreeError();
  const eventId = await createTaggedEvent({
    summary,
    description,
    date,
    startTime,
    endTime,
  });
  await supabase
    .from("quotes")
    .update({ status: "confirmed", calendar_event_id: eventId })
    .eq("id", quoteId);
  return { status: "confirmed", eventId };
}

/**
 * Move the tentative hold to a new slot (Phase 7, on an approved reschedule
 * reply). Releases the old tentative event, re-checks the new slot, places a
 * fresh tentative hold, and updates the quote's proposed appointment. The new
 * time remains a PROPOSAL (not confirmed) until the customer accepts it.
 */
export async function rescheduleTentativeHold(
  quoteId: string,
  slot: Slot
): Promise<HoldResult> {
  const supabase = getSupabaseAdmin();
  const { quote, inquiry } = await loadQuoteAndInquiry(quoteId);

  const free = await isSlotStillFree({
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    ignoreEventId: quote.calendar_event_id ?? undefined,
  });
  if (!free) throw new SlotNoLongerFreeError();

  // Release the superseded hold before placing the new one.
  if (quote.calendar_event_id) {
    await deleteEvent(quote.calendar_event_id);
  }

  const name = inquiry?.name ?? "asiakas";
  const service = serviceLabel(inquiry?.service_type ?? null);
  const eventId = await createTaggedEvent({
    summary: `Tentative – ${name} – Quote awaiting acceptance`,
    description: [
      "Alustava (tentative) varaus — uusi ehdotettu aika, odottaa asiakkaan vahvistusta.",
      `Palvelu: ${service}`,
      `Quote ID: ${quoteId}`,
    ].join("\n"),
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
  });

  await supabase
    .from("quotes")
    .update({
      proposed_date: slot.date,
      proposed_start_time: slot.startTime,
      proposed_end_time: slot.endTime,
      calendar_event_id: eventId,
    })
    .eq("id", quoteId);

  return { status: "held", eventId };
}
