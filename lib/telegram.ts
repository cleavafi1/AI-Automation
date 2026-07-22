import { serviceLabel } from "./constants";
import type { Inquiry, Quote, ReplyIntent } from "./types";

// Minimal Telegram Bot API client + the staff quote-notification message.
// Server-only. Uses fetch against the Bot API; no third-party dependency.

const API_BASE = "https://api.telegram.org";

export type TelegramConfig = {
  token: string;
  // All authorized staff chat ids. TELEGRAM_STAFF_CHAT_ID may hold one id or a
  // comma-separated list (e.g. "7775766502,6190627659") — every id receives
  // quote notifications and is allowed to approve/decline/edit.
  staffChatIds: string[];
  // The primary (first) id — used where a single target is needed and for the
  // stored telegram_message_id.
  staffChatId: string;
};

/** Parse TELEGRAM_STAFF_CHAT_ID into a de-duped list (comma/space separated). */
function parseStaffChatIds(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

export function getTelegramConfig(): TelegramConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const staffRaw = process.env.TELEGRAM_STAFF_CHAT_ID;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  if (!staffRaw)
    throw new Error("Missing TELEGRAM_STAFF_CHAT_ID environment variable.");
  const staffChatIds = parseStaffChatIds(staffRaw);
  if (staffChatIds.length === 0)
    throw new Error("TELEGRAM_STAFF_CHAT_ID has no valid chat ids.");
  return { token, staffChatIds, staffChatId: staffChatIds[0] };
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

// Phase 7: the same three-button flow, but for an inbound-reply review. The
// callback_data uses a "cv*" prefix + the email_conversations row id so the
// webhook can tell a reply approval apart from an original-offer approval.
export function conversationActionKeyboard(conversationId: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `cvapprove:${conversationId}` },
        { text: "❌ Decline", callback_data: `cvdecline:${conversationId}` },
        { text: "✏️ Custom", callback_data: `cvcustom:${conversationId}` },
      ],
    ],
  };
}

const INTENT_LABEL: Record<ReplyIntent, string> = {
  acceptance: "✅ HYVÄKSYNTÄ — asiakas hyväksyy ajan",
  reschedule_request: "🔄 AJANMUUTOSPYYNTÖ",
  question: "❓ KYSYMYS",
  decline: "🚫 PERUUTUS / ei halua edetä",
  unclear: "⚠️ EPÄSELVÄ — vaatii erityistä huomiota",
};

/** The staff-facing review body for a classified inbound reply + drafted answer. */
export function buildReplyReviewText(params: {
  inquiry: Inquiry;
  intent: ReplyIntent;
  reasoning: string;
  customerReply: string;
  draftedResponse: string;
  newSlotText?: string | null;
}): string {
  const { inquiry, intent, reasoning, customerReply, draftedResponse, newSlotText } =
    params;
  return [
    "📨 Uusi asiakasvastaus tarkistettavaksi",
    "",
    `Asiakas: ${inquiry.name}`,
    `Palvelu: ${serviceLabel(inquiry.service_type)}`,
    `Luokitus: ${INTENT_LABEL[intent]}`,
    reasoning ? `Perustelu: ${reasoning}` : "",
    newSlotText ? `Uusi ehdotettu aika: ${newSlotText}` : "",
    intent === "unclear"
      ? "⚠️ HUOMIO: luokitus epävarma — tarkista viesti huolellisesti."
      : "",
    "",
    "— Asiakkaan viesti —",
    customerReply,
    "",
    "— Ehdotettu vastaus asiakkaalle —",
    draftedResponse,
  ]
    .filter(Boolean)
    .join("\n");
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

/** Register the webhook URL with Telegram (called server-side from Netlify). */
export async function setWebhook(url: string): Promise<unknown> {
  const payload: Record<string, unknown> = {
    url,
    allowed_updates: ["message", "callback_query"],
  };
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) payload.secret_token = secret;
  return tgCall("setWebhook", payload);
}

export async function getWebhookInfo(): Promise<unknown> {
  return tgCall("getWebhookInfo", {});
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

function billingText(inq: Inquiry): string {
  const parts = [
    inq.billing_street,
    inq.billing_building_number,
    inq.billing_apartment,
    inq.postal_code,
    inq.city,
  ].filter(Boolean);
  const known = parts.length ? parts.join(" ") : "—";
  return inq.needs_billing_address ? `${known} ⚠️ (puuttuu/vajaa)` : known;
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
    `Laskutusosoite: ${billingText(inq)}`,
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
  const { staffChatIds } = getTelegramConfig();
  const text = buildQuoteNotificationText(quote, inq);
  const replyMarkup = quoteActionKeyboard(quote.id);

  // Send to the primary recipient first — a failure here throws (callers wrap
  // it, so a Telegram outage can't break quote generation). Its message_id is
  // the one stored on the quote.
  const [primaryId, ...others] = staffChatIds;
  const primaryMessageId = await sendMessage({
    chatId: primaryId,
    text,
    replyMarkup,
  });

  // Additional recipients are best-effort: one bad/blocked id must not stop the
  // others or fail the whole notification.
  for (const chatId of others) {
    try {
      await sendMessage({ chatId, text, replyMarkup });
    } catch (err) {
      console.error(
        `[telegram] failed to notify additional staff chat ${chatId}:`,
        err
      );
    }
  }

  return primaryMessageId;
}

/**
 * Send a classified-reply review (Phase 7) to all staff with the same
 * Approve/Decline/Custom buttons, wired to the conversation row. Returns the
 * primary recipient's message_id. Mirrors sendQuoteNotification's fan-out.
 */
export async function sendReplyReviewNotification(
  conversationId: string,
  text: string
): Promise<number> {
  const { staffChatIds } = getTelegramConfig();
  const replyMarkup = conversationActionKeyboard(conversationId);
  const [primaryId, ...others] = staffChatIds;
  const primaryMessageId = await sendMessage({
    chatId: primaryId,
    text,
    replyMarkup,
  });
  for (const chatId of others) {
    try {
      await sendMessage({ chatId, text, replyMarkup });
    } catch (err) {
      console.error(
        `[telegram] failed to send reply review to staff chat ${chatId}:`,
        err
      );
    }
  }
  return primaryMessageId;
}
