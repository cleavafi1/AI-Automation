import { serviceLabel } from "./constants";
import type { Inquiry, Quote } from "./types";

// Minimal Telegram Bot API client + the staff quote-notification message.
// Server-only. Uses fetch against the Bot API; no third-party dependency.

const API_BASE = "https://api.telegram.org";

export type TelegramConfig = { token: string; staffChatId: string };

export function getTelegramConfig(): TelegramConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const staffChatId = process.env.TELEGRAM_STAFF_CHAT_ID;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  if (!staffChatId)
    throw new Error("Missing TELEGRAM_STAFF_CHAT_ID environment variable.");
  return { token, staffChatId };
}

/** True when Telegram is configured (so callers can no-op gracefully if not). */
export function isTelegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_STAFF_CHAT_ID;
}

type TgResult<T> = { ok: boolean; result?: T; description?: string };

async function tgCall<T = unknown>(
  method: string,
  payload: Record<string, unknown>
): Promise<T> {
  const { token } = getTelegramConfig();
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => null)) as TgResult<T> | null;
  if (!res.ok || !json || !json.ok) {
    throw new Error(
      `Telegram ${method} failed (${res.status}): ${
        json?.description ?? "unknown error"
      }`
    );
  }
  return json.result as T;
}

// The three staff-action buttons attached to every quote message. callback_data
// is "<action>:<quoteId>" — well under Telegram's 64-byte limit.
export function quoteActionKeyboard(quoteId: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `approve:${quoteId}` },
        { text: "❌ Decline", callback_data: `decline:${quoteId}` },
        { text: "✏️ Custom", callback_data: `custom:${quoteId}` },
      ],
    ],
  };
}

export async function sendMessage(params: {
  chatId: string | number;
  text: string;
  replyMarkup?: unknown;
}): Promise<number> {
  const msg = await tgCall<{ message_id: number }>("sendMessage", {
    chat_id: params.chatId,
    text: params.text,
    reply_markup: params.replyMarkup,
    disable_web_page_preview: true,
  });
  return msg.message_id;
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await tgCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

/** Remove the inline buttons from a message (e.g. after it's been acted on). */
export async function clearButtons(
  chatId: string | number,
  messageId: number
): Promise<void> {
  try {
    await tgCall("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (err) {
    // Non-fatal — the message may be too old to edit. Log and continue.
    console.error("[telegram] clearButtons failed:", err);
  }
}

function locationText(inq: Inquiry): string {
  const parts = [inq.postal_code, inq.city].filter(Boolean);
  return parts.length ? parts.join(" ") : "—";
}

function sizeText(inq: Inquiry): string {
  return inq.property_size_m2 != null ? `${inq.property_size_m2} m²` : "—";
}

function priceText(quote: Quote): string {
  return quote.estimated_price_eur != null
    ? `${quote.estimated_price_eur} € alkaen`
    : "quote-only (tarjouspohjainen)";
}

function proposedText(quote: Quote): string {
  if (!quote.proposed_date) return "no slot found";
  const [y, m, d] = quote.proposed_date.split("-");
  const s = (quote.proposed_start_time ?? "").slice(0, 5);
  const e = (quote.proposed_end_time ?? "").slice(0, 5);
  const range = s && e ? ` klo ${s}–${e}` : "";
  return `${d}.${m}.${y}${range}`;
}

/** The full staff-facing notification body for a quote. Plain text. */
export function buildQuoteNotificationText(quote: Quote, inq: Inquiry): string {
  return [
    "🧾 Uusi tarjous tarkistettavaksi",
    "",
    `Asiakas: ${inq.name}`,
    `Palvelu: ${serviceLabel(inq.service_type)}`,
    `Koko: ${sizeText(inq)}`,
    `Sijainti: ${locationText(inq)}`,
    `Hinta: ${priceText(quote)}`,
    `Ehdotettu aika: ${proposedText(quote)}`,
    quote.is_flagged
      ? `⚑ Liputus: ${quote.flag_reason ?? "vaatii tarkistuksen"}`
      : "⚑ Liputus: —",
    "",
    "— Asiakkaalle menevä luonnos —",
    quote.drafted_text,
  ].join("\n");
}

/**
 * Send the staff notification for a quote with the three action buttons.
 * Returns the Telegram message_id (stored on the quote). Throws on failure —
 * callers wrap it so a Telegram outage can't break quote generation.
 */
export async function sendQuoteNotification(
  quote: Quote,
  inq: Inquiry
): Promise<number> {
  const { staffChatId } = getTelegramConfig();
  return sendMessage({
    chatId: staffChatId,
    text: buildQuoteNotificationText(quote, inq),
    replyMarkup: quoteActionKeyboard(quote.id),
  });
}
