import { getSupabaseAdmin } from "./supabase";
import { sendEmail } from "./email";
import { replyToAddressForQuote } from "./reply-address";
import {
  insertConversation,
  loadConversationHistory,
} from "./email-conversations";
import { classifyReply } from "./reply-classify";
import { draftReplyResponse, formatAppointment } from "./reply-draft";
import { reserveHoursForQuote } from "./quote-duration";
import { findNearestAvailableSlot, type Slot } from "./booking";
import { parseHelsinkiDateTime } from "./timezone";
import {
  confirmBooking,
  rescheduleTentativeHold,
  SlotNoLongerFreeError,
} from "./tentative-hold";
import {
  buildReplyReviewText,
  sendReplyReviewNotification,
  isTelegramConfigured,
} from "./telegram";
import type { EmailConversation, Inquiry, Quote } from "./types";

// Phase 7 orchestration: inbound reply → classify → draft → Telegram review,
// and the Approve/Decline actions that follow a staff tap. Every customer-facing
// send happens ONLY on an explicit Approve; nothing here emails autonomously.

export type ParsedInbound = {
  quoteId: string;
  fromAddress: string;
  subject: string | null;
  bodyText: string;
  resendEmailId: string | null;
};

export type InboundResult =
  | { matched: false }
  | {
      matched: true;
      conversationId: string;
      intent: string;
      telegramSent: boolean;
    };

async function loadQuoteInquiry(
  quoteId: string
): Promise<{ quote: Quote; inquiry: Inquiry } | null> {
  const supabase = getSupabaseAdmin();
  const { data: quote } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  if (!quote) return null;
  const typedQuote = quote as Quote;
  const { data: inq } = await supabase
    .from("inquiries")
    .select("*")
    .eq("id", typedQuote.inquiry_id)
    .maybeSingle();
  if (!inq) return null;
  return { quote: typedQuote, inquiry: inq as Inquiry };
}

function toSlot(
  date: string,
  startTime: string,
  endTime: string
): Slot | null {
  const startInstant = parseHelsinkiDateTime(date, startTime);
  const endInstant = parseHelsinkiDateTime(date, endTime);
  if (!startInstant || !endInstant) return null;
  return { date, startTime, endTime, startInstant, endInstant };
}

/**
 * Process a verified inbound reply: record it, classify it against history,
 * draft a response (running availability for reschedules), store the draft as a
 * pending_review outbound row, and post it to Telegram for Approve/Decline.
 */
export async function processInboundReply(
  parsed: ParsedInbound
): Promise<InboundResult> {
  const loaded = await loadQuoteInquiry(parsed.quoteId);
  if (!loaded) {
    console.error(
      `[reply-flow] no quote found for inbound reply to quote ${parsed.quoteId}`
    );
    return { matched: false };
  }
  const { quote, inquiry } = loaded;

  // Prior history (before recording this new inbound message) is the context.
  const history = await loadConversationHistory(quote.id);

  // 1. Classify.
  const classification = await classifyReply({
    quote,
    inquiry,
    history,
    replyText: parsed.bodyText,
  });

  // 2. Record the inbound message (with its classification).
  await insertConversation({
    quote_id: quote.id,
    direction: "inbound",
    from_address: parsed.fromAddress,
    subject: parsed.subject,
    body_text: parsed.bodyText,
    resend_email_id: parsed.resendEmailId,
    classified_intent: classification.intent,
    status: "approved", // inbound is a recorded fact, not a pending draft
  });

  // 3. For a reschedule, re-run availability (same forward-only + gap rules).
  let newSlot: Slot | null = null;
  if (classification.intent === "reschedule_request") {
    try {
      const durationHours = await reserveHoursForQuote(quote, inquiry);
      const requested =
        classification.requested_date != null
          ? parseHelsinkiDateTime(
              classification.requested_date,
              classification.requested_time ?? "08:00"
            )
          : null;
      newSlot = await findNearestAvailableSlot({
        durationHours,
        requested,
        deadline: classification.date_is_deadline,
      });
    } catch (err) {
      console.error("[reply-flow] reschedule availability lookup failed:", err);
      newSlot = null;
    }
  }

  // 4. Draft the customer-facing response.
  const draftedResponse = await draftReplyResponse({
    intent: classification.intent,
    quote,
    inquiry,
    history,
    replyText: parsed.bodyText,
    language: classification.language,
    newSlot,
  });

  // 5. Store the drafted response as a pending_review outbound row.
  const outbound = await insertConversation({
    quote_id: quote.id,
    direction: "outbound",
    from_address: null,
    subject: parsed.subject ? `Re: ${parsed.subject}` : "Cleava",
    body_text: draftedResponse,
    classified_intent: classification.intent,
    status: "pending_review",
    proposed_date: newSlot?.date ?? null,
    proposed_start_time: newSlot?.startTime ?? null,
    proposed_end_time: newSlot?.endTime ?? null,
  });

  // 6. Post to Telegram for review (best-effort — must not lose the draft).
  let telegramSent = false;
  if (isTelegramConfigured()) {
    const newSlotText = newSlot
      ? formatAppointment(
          newSlot.date,
          newSlot.startTime,
          newSlot.endTime,
          classification.language
        )
      : classification.intent === "reschedule_request"
        ? "ei vapaata aikaa löytynyt"
        : null;
    const text = buildReplyReviewText({
      inquiry,
      intent: classification.intent,
      reasoning: classification.reasoning,
      customerReply: parsed.bodyText,
      draftedResponse,
      newSlotText,
    });
    try {
      const messageId = await sendReplyReviewNotification(outbound.id, text);
      await getSupabaseAdmin()
        .from("email_conversations")
        .update({ telegram_message_id: messageId })
        .eq("id", outbound.id);
      telegramSent = true;
    } catch (err) {
      console.error("[reply-flow] Telegram review send failed:", err);
    }
  }

  return {
    matched: true,
    conversationId: outbound.id,
    intent: classification.intent,
    telegramSent,
  };
}

async function loadOutbound(
  conversationId: string
): Promise<EmailConversation | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("email_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  return (data as EmailConversation) ?? null;
}

export type ApproveReplyResult = {
  emailSent: boolean;
  calendarAction: "confirmed" | "rescheduled" | "none";
};

/**
 * Approve a pending reply: send the drafted email (reply-to still set for the
 * next round), and apply the calendar action for its intent — confirm the
 * booking on acceptance, move the tentative hold on reschedule. Throws
 * SlotNoLongerFreeError if a final availability re-check fails.
 */
export async function approveConversationReply(
  conversationId: string
): Promise<ApproveReplyResult> {
  const supabase = getSupabaseAdmin();
  const row = await loadOutbound(conversationId);
  if (!row) throw new Error(`Conversation row not found: ${conversationId}`);
  if (row.direction !== "outbound") {
    throw new Error("Cannot approve a non-outbound conversation row.");
  }
  // Idempotency: only a pending row can be approved (guards double-taps/retries).
  if (row.status !== "pending_review") {
    return { emailSent: false, calendarAction: "none" };
  }

  const loaded = await loadQuoteInquiry(row.quote_id);
  if (!loaded) throw new Error(`Quote not found for reply ${conversationId}`);
  const { quote, inquiry } = loaded;

  // Calendar side-effects FIRST (a failed re-check must block the send too).
  let calendarAction: "confirmed" | "rescheduled" | "none" = "none";
  if (row.classified_intent === "acceptance") {
    await confirmBooking(quote.id); // throws SlotNoLongerFreeError if taken
    calendarAction = "confirmed";
  } else if (
    row.classified_intent === "reschedule_request" &&
    row.proposed_date &&
    row.proposed_start_time &&
    row.proposed_end_time
  ) {
    const slot = toSlot(
      row.proposed_date,
      row.proposed_start_time.slice(0, 5),
      row.proposed_end_time.slice(0, 5)
    );
    if (slot) {
      await rescheduleTentativeHold(quote.id, slot);
      calendarAction = "rescheduled";
    }
  }

  // Send the email (reply-to still set so the conversation can continue).
  const result = await sendEmail({
    to: inquiry.email,
    subject: row.subject ?? "Cleava",
    text: row.body_text ?? "",
    replyTo: replyToAddressForQuote(quote.id),
  });

  await supabase
    .from("email_conversations")
    .update({ status: "approved", resend_email_id: result.id })
    .eq("id", conversationId);

  return { emailSent: true, calendarAction };
}

/** Decline a pending reply: no email sent, mark declined, log the reason. */
export async function declineConversationReply(
  conversationId: string,
  reason?: string
): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase
    .from("email_conversations")
    .update({ status: "declined" })
    .eq("id", conversationId);
  console.log(
    `[reply-flow] reply ${conversationId} declined by staff. Reason: ${
      reason ?? "(none given)"
    }`
  );
}
