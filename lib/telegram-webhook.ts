import { getSupabaseAdmin } from "./supabase";
import {
  getTelegramConfig,
  sendMessage,
  answerCallbackQuery,
  clearButtons,
  sendQuoteNotification,
} from "./telegram";
import { approveAndSend } from "./approve-send";
import { SlotNoLongerFreeError } from "./tentative-hold";
import { reviseQuoteDraft } from "./telegram-edit";
import { applyStandardClosing } from "./signature";
import { findNearestAvailableSlot } from "./booking";
import { resolvePricing } from "./pricing";
import { computeEstimate } from "./extraction";
import { parseHelsinkiDateTime, normalizeHHMM } from "./timezone";
import type { Inquiry, PricingTier, Quote, TelegramPendingEdit, TimeEstimate } from "./types";

// Stateless Telegram webhook handling. Two update kinds:
//   • callback_query — an inline button press (approve/decline/custom)
//   • message        — a plain text follow-up (a custom-edit instruction or a
//                      decline reason), correlated via telegram_pending_edits.
//
// Every path is best-effort and swallows its own errors into a Telegram reply,
// so the webhook route can always return 200 (Telegram retries non-2xx).

// Minimal shapes of the Telegram update we consume.
type TgUpdate = {
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
  };
};

function isStaffChat(chatId: number | undefined): boolean {
  if (chatId == null) return false;
  const { staffChatIds } = getTelegramConfig();
  return staffChatIds.includes(String(chatId));
}

export async function processTelegramUpdate(update: unknown): Promise<void> {
  const u = update as TgUpdate;
  if (u.callback_query) {
    await handleCallback(u.callback_query);
  } else if (u.message && typeof u.message.text === "string") {
    await handleText(u.message);
  }
}

// ---------------------------------------------------------------------------
// Button presses
// ---------------------------------------------------------------------------

async function handleCallback(cq: NonNullable<TgUpdate["callback_query"]>) {
  const chatId = cq.message?.chat.id;
  // Always ack the button so Telegram stops the loading spinner.
  await answerCallbackQuery(cq.id).catch(() => {});
  if (!isStaffChat(chatId) || !cq.data || !cq.message) return;

  const [action, quoteId] = cq.data.split(":");
  if (!quoteId) return;
  const messageId = cq.message.message_id;

  if (action === "approve") return handleApprove(chatId!, messageId, quoteId);
  if (action === "decline") return handleDecline(chatId!, messageId, quoteId);
  if (action === "custom") return handleCustom(chatId!, quoteId);
}

async function loadQuote(quoteId: string): Promise<Quote | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  return (data as Quote) ?? null;
}

async function handleApprove(
  chatId: number,
  messageId: number,
  quoteId: string
) {
  const quote = await loadQuote(quoteId);
  if (!quote) {
    await sendMessage({ chatId, text: "Tarjousta ei löytynyt." });
    return;
  }
  // Idempotency guard: only act on a still-draft quote (prevents double-send on
  // a re-press or a Telegram retry).
  if (quote.status !== "draft") {
    await sendMessage({
      chatId,
      text: `Tämä tarjous on jo käsitelty (tila: ${quote.status}).`,
    });
    return;
  }

  try {
    const { hold } = await approveAndSend(quoteId);
    await clearButtons(chatId, messageId);
    const text =
      hold.status === "needs_clarification"
        ? "✅ Hyväksytty. Asiakkaalle lähetettiin TARKENNUSPYYNTÖ.\n⚠️ Kalenteriin EI tehty varausta, koska pyynnöstä puuttui tietoja (needs_clarification). Kun asiakas täydentää tiedot, tee tarjous uudelleen."
        : hold.status === "no_slot"
          ? "✅ Hyväksytty ja lähetetty asiakkaalle. Ei ehdotettua aikaa, joten kalenteriin ei tehty varausta."
          : "✅ Hyväksytty ja lähetetty asiakkaalle. Alustava varaus tehty kalenteriin ehdotetulle ajalle.";
    await sendMessage({ chatId, text });
  } catch (err) {
    if (err instanceof SlotNoLongerFreeError) {
      await sendMessage({
        chatId,
        text: "⚠️ Ehdotettu aika ei ole enää vapaa. Tarjousta EI lähetetty. Muokkaa aikaa (✏️ Custom) ja yritä uudelleen.",
      });
      // Revert the approval so it can be retried after editing.
      await getSupabaseAdmin()
        .from("quotes")
        .update({ status: "draft" })
        .eq("id", quoteId);
      return;
    }
    console.error("[telegram] approve failed:", err);
    await sendMessage({
      chatId,
      text: "Hyväksyntä epäonnistui. Tarkista lokit ja yritä uudelleen.",
    });
  }
}

async function handleDecline(
  chatId: number,
  messageId: number,
  quoteId: string
) {
  const supabase = getSupabaseAdmin();
  const quote = await loadQuote(quoteId);
  if (!quote) {
    await sendMessage({ chatId, text: "Tarjousta ei löytynyt." });
    return;
  }
  if (quote.status !== "draft") {
    await sendMessage({
      chatId,
      text: `Tämä tarjous on jo käsitelty (tila: ${quote.status}).`,
    });
    return;
  }

  await supabase.from("quotes").update({ status: "declined" }).eq("id", quoteId);
  // Expect a follow-up decline reason from this chat next.
  await upsertPendingEdit(chatId, quoteId, "decline_reason");
  await clearButtons(chatId, messageId);
  await sendMessage({
    chatId,
    text: "❌ Hylätty. Syy (valinnainen)? Vastaa viestillä, tai jätä huomiotta.",
  });
}

async function handleCustom(chatId: number, quoteId: string) {
  const quote = await loadQuote(quoteId);
  if (!quote) {
    await sendMessage({ chatId, text: "Tarjousta ei löytynyt." });
    return;
  }
  await upsertPendingEdit(chatId, quoteId, "edit");
  await sendMessage({
    chatId,
    text: "✏️ Lähetä muutokset vapaalla kielellä, esim. \"muuta hinta 180 €:oon ja siirrä perjantaille klo 12\".",
  });
}

// ---------------------------------------------------------------------------
// Text follow-ups (edit instruction or decline reason)
// ---------------------------------------------------------------------------

async function handleText(message: NonNullable<TgUpdate["message"]>) {
  const chatId = message.chat.id;
  if (!isStaffChat(chatId)) return;
  const text = (message.text ?? "").trim();
  if (!text) return;

  const supabase = getSupabaseAdmin();
  // Most recent pending follow-up for this chat.
  const { data } = await supabase
    .from("telegram_pending_edits")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(1);
  const pending = (data?.[0] as TelegramPendingEdit) ?? null;
  if (!pending) return; // not expecting anything from this chat — ignore

  // Claim the pending row immediately (delete) so a Telegram retry of the same
  // message can't double-process the long Claude call below.
  await supabase.from("telegram_pending_edits").delete().eq("id", pending.id);

  if (pending.kind === "decline_reason") {
    await supabase
      .from("quotes")
      .update({ decline_reason: text })
      .eq("id", pending.quote_id);
    await sendMessage({ chatId, text: "Kiitos, syy kirjattu." });
    return;
  }

  // kind === 'edit'
  await handleEdit(chatId, pending.quote_id, text);
}

async function handleEdit(chatId: number, quoteId: string, instruction: string) {
  const supabase = getSupabaseAdmin();
  const quote = await loadQuote(quoteId);
  if (!quote) {
    await sendMessage({ chatId, text: "Tarjousta ei löytynyt." });
    return;
  }
  const { data: inqData } = await supabase
    .from("inquiries")
    .select("*")
    .eq("id", quote.inquiry_id)
    .maybeSingle();
  const inquiry = (inqData as Inquiry) ?? null;
  if (!inquiry) {
    await sendMessage({ chatId, text: "Tarjouksen tiedustelua ei löytynyt." });
    return;
  }

  let revision;
  try {
    revision = await reviseQuoteDraft({ quote, inquiry, instruction });
  } catch (err) {
    console.error("[telegram] revise failed:", err);
    await sendMessage({
      chatId,
      text: "Muokkaus epäonnistui. Yritä uudelleen (✏️ Custom).",
    });
    return;
  }

  // Re-apply the one canonical closing block so an edit can't drop or double it.
  const updates: Record<string, unknown> = {
    drafted_text: applyStandardClosing(revision.revised_text),
  };
  const notes: string[] = [];

  if (revision.price_changed && revision.new_price_eur != null) {
    updates.estimated_price_eur = revision.new_price_eur;
  }

  // If the schedule changed, re-run availability for the new requested slot.
  if (revision.schedule_changed && revision.new_date) {
    const durationHours = await quoteDurationHours(quote, inquiry, supabase);
    const startForRequest =
      revision.new_time ??
      normalizeHHMM(quote.proposed_start_time ?? "08:00") ??
      "08:00";
    const requested = parseHelsinkiDateTime(revision.new_date, startForRequest);
    try {
      const slot = await findNearestAvailableSlot({
        durationHours,
        requested,
      });
      if (slot) {
        updates.proposed_date = slot.date;
        updates.proposed_start_time = slot.startTime;
        updates.proposed_end_time = slot.endTime;
        // A newly-proposed slot invalidates any earlier tentative hold.
        updates.calendar_event_id = null;
        if (slot.date !== revision.new_date || slot.startTime !== startForRequest) {
          notes.push(
            `Huom: haluttu aika ei ollut vapaana — lähin vapaa: ${slot.date} klo ${slot.startTime}–${slot.endTime}.`
          );
        }
      } else {
        notes.push("Huom: haluttuna päivänä ei ollut vapaata aikaa — aika jätettiin ennalleen.");
      }
    } catch (err) {
      console.error("[telegram] edit availability re-check failed:", err);
      notes.push("Huom: kalenterin tarkistus epäonnistui — aika jätettiin ennalleen.");
    }
  }

  const { error: updErr } = await supabase
    .from("quotes")
    .update(updates)
    .eq("id", quoteId);
  if (updErr) {
    console.error("[telegram] edit save failed:", updErr.message);
    await sendMessage({ chatId, text: "Tallennus epäonnistui." });
    return;
  }

  // Send the revised quote back with a fresh set of buttons (loop continues).
  const updatedQuote = await loadQuote(quoteId);
  if (!updatedQuote) return;
  const summary = [`✏️ Päivitetty: ${revision.change_summary}`, ...notes].join("\n");
  await sendMessage({ chatId, text: summary });
  try {
    const newMessageId = await sendQuoteNotification(updatedQuote, inquiry);
    await supabase
      .from("quotes")
      .update({ telegram_message_id: newMessageId })
      .eq("id", quoteId);
  } catch (err) {
    console.error("[telegram] resend after edit failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// One pending row per quote (unique index). A new press replaces the prior one.
async function upsertPendingEdit(
  chatId: number,
  quoteId: string,
  kind: "edit" | "decline_reason"
) {
  const supabase = getSupabaseAdmin();
  await supabase.from("telegram_pending_edits").delete().eq("quote_id", quoteId);
  await supabase
    .from("telegram_pending_edits")
    .insert({ chat_id: chatId, quote_id: quoteId, kind });
}

// Duration to reserve when re-checking availability after a schedule edit.
// Prefer the existing proposed slot's length; otherwise recompute the estimate.
async function quoteDurationHours(
  quote: Quote,
  inquiry: Inquiry,
  supabase: ReturnType<typeof getSupabaseAdmin>
): Promise<number> {
  const s = normalizeHHMM(quote.proposed_start_time ?? "");
  const e = normalizeHHMM(quote.proposed_end_time ?? "");
  if (s && e) {
    const [sh, sm] = s.split(":").map(Number);
    const [eh, em] = e.split(":").map(Number);
    const hours = (eh * 60 + em - (sh * 60 + sm)) / 60;
    if (hours > 0) return hours;
  }
  // Fallback: recompute from pricing + estimation guide (upper bound hours).
  const { data: tiers } = await supabase
    .from("pricing_tiers")
    .select("*")
    .eq("service_type", inquiry.service_type ?? "");
  const pricing = resolvePricing(inquiry, (tiers ?? []) as PricingTier[]);
  const { data: estRows } = await supabase
    .from("time_estimates")
    .select("*")
    .eq("service_type", inquiry.service_type ?? "");
  const estimate = computeEstimate(
    inquiry.service_type,
    inquiry.property_size_m2,
    pricing,
    (estRows ?? []) as TimeEstimate[],
    2
  );
  // Reserve the wall-clock finish time (total ÷ cleaners), matching generation.
  return estimate.finishHoursMax ?? estimate.hoursMax ?? 2;
}
