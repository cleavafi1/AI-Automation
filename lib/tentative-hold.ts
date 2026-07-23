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

// --- Calendar event formatting (matches Cleava staff's manual booking style) ---
// Title:    "{FirstName} {Nh} Offerilla {service} {size}m² {phone}"
// Location: customer address (so it maps). Description: full details.
// Tentative holds get an "(alustava)" prefix so staff can tell them apart.

function firstNameOf(name: string | null | undefined): string {
  const n = (name ?? "").trim().split(/\s+/)[0];
  return n || "asiakas";
}

function onsiteHoursLabel(startTime: string, endTime: string): string {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const h = (eh * 60 + em - (sh * 60 + sm)) / 60;
  if (!Number.isFinite(h) || h <= 0) return "";
  return `${Number.isInteger(h) ? String(h) : String(h).replace(".", ",")}h`;
}

function customerAddress(inq: Inquiry | null): string {
  const street = [
    inq?.billing_street,
    inq?.billing_building_number,
    inq?.billing_apartment,
  ]
    .filter(Boolean)
    .join(" ");
  const cityLine = [inq?.postal_code, inq?.city].filter(Boolean).join(" ");
  return [street, cityLine].filter(Boolean).join(", ");
}

function bookingTitle(
  inq: Inquiry | null,
  startTime: string,
  endTime: string
): string {
  const parts: string[] = [firstNameOf(inq?.name)];
  const hrs = onsiteHoursLabel(startTime, endTime);
  if (hrs) parts.push(hrs);
  parts.push("Offerilla");
  if (inq?.service_type) parts.push(serviceLabel(inq.service_type).toLowerCase());
  if (inq?.property_size_m2 != null) parts.push(`${inq.property_size_m2}m²`);
  if (inq?.phone) parts.push(inq.phone);
  return parts.join(" ");
}

function bookingDescription(
  inq: Inquiry | null,
  quote: Quote,
  confirmed: boolean
): string {
  return [
    confirmed
      ? "Vahvistettu varaus (asiakas hyväksynyt tarjouksen)."
      : "Alustava (tentative) varaus — odottaa asiakkaan vahvistusta.",
    inq?.name ? `Asiakas: ${inq.name}` : null,
    inq?.phone ? `Puhelin: ${inq.phone}` : null,
    inq?.email ? `Sähköposti: ${inq.email}` : null,
    `Palvelu: ${serviceLabel(inq?.service_type ?? null)}`,
    inq?.property_size_m2 != null ? `Koko: ${inq.property_size_m2} m²` : null,
    customerAddress(inq) ? `Osoite: ${customerAddress(inq)}` : null,
    quote.estimated_price_eur != null
      ? `Arviohinta: ${quote.estimated_price_eur} € alkaen`
      : null,
    inq?.notes ? `Lisätiedot: ${inq.notes}` : null,
    `Quote ID: ${quote.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

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
  const eventId = await createTaggedEvent({
    summary: `(alustava) ${bookingTitle(typedInquiry, startTime, endTime)}`,
    description: bookingDescription(typedInquiry, typedQuote, false),
    location: customerAddress(typedInquiry) || undefined,
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

  const summary = bookingTitle(inquiry, startTime, endTime);
  const description = bookingDescription(inquiry, quote, true);
  const location = customerAddress(inquiry) || undefined;

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
      await updateEvent(quote.calendar_event_id, { summary, description, location });
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
    location,
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

  const eventId = await createTaggedEvent({
    summary: `(alustava) ${bookingTitle(inquiry, slot.startTime, slot.endTime)}`,
    description: bookingDescription(inquiry, quote, false),
    location: customerAddress(inquiry) || undefined,
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
