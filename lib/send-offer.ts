import { getSupabaseAdmin } from "./supabase";
import { sendEmail } from "./email";
import type { Inquiry, Quote, EmailLog } from "./types";

// Typed errors so the API route can map to precise HTTP statuses.
export class QuoteNotFoundError extends Error {
  constructor(id: string) {
    super(`Quote not found: ${id}`);
    this.name = "QuoteNotFoundError";
  }
}

export class QuoteNotApprovedError extends Error {
  constructor(status: string) {
    super(`Quote status is '${status}', must be 'approved' to send.`);
    this.name = "QuoteNotApprovedError";
  }
}

export class OfferSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferSendError";
  }
}

const OFFER_SUBJECT = "Tarjous siivouspalvelusta – Cleava";

export type SendOfferResult = {
  emailLog: EmailLog;
};

/**
 * Send the drafted offer for a quote to the inquiry's email address, then log
 * the attempt to emails_log. Requires the quote to be 'approved'.
 * Uses plain text (the drafted quotes are plain paragraphs — HTML can come later).
 */
export async function sendOfferForQuote(
  quoteId: string
): Promise<SendOfferResult> {
  const supabase = getSupabaseAdmin();

  // 1. Load the quote.
  const { data: quote, error: quoteError } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();

  if (quoteError) {
    throw new Error(`Failed to load quote: ${quoteError.message}`);
  }
  if (!quote) {
    throw new QuoteNotFoundError(quoteId);
  }
  const typedQuote = quote as Quote;

  // 2. Must be approved before sending.
  if (typedQuote.status !== "approved") {
    throw new QuoteNotApprovedError(typedQuote.status);
  }

  // 3. Load the inquiry (for the recipient address).
  const { data: inquiry, error: inquiryError } = await supabase
    .from("inquiries")
    .select("*")
    .eq("id", typedQuote.inquiry_id)
    .maybeSingle();

  if (inquiryError) {
    throw new Error(`Failed to load inquiry: ${inquiryError.message}`);
  }
  if (!inquiry) {
    throw new OfferSendError(
      `Inquiry ${typedQuote.inquiry_id} for quote ${quoteId} not found.`
    );
  }
  const typedInquiry = inquiry as Inquiry;

  const toAddress = typedInquiry.email;
  const subject = OFFER_SUBJECT;
  const body = typedQuote.drafted_text;

  // 4. Attempt the send; log either outcome to emails_log.
  let resendMessageId: string | null = null;
  let status: "sent" | "failed" = "sent";
  let sendErrorMessage: string | null = null;

  try {
    const result = await sendEmail({ to: toAddress, subject, text: body });
    resendMessageId = result.id;
  } catch (err) {
    status = "failed";
    sendErrorMessage = err instanceof Error ? err.message : String(err);
    // Log the real error server-side.
    console.error("[send-offer] email send failed:", err);
  }

  const { data: logRow, error: logError } = await supabase
    .from("emails_log")
    .insert({
      inquiry_id: typedInquiry.id,
      quote_id: typedQuote.id,
      direction: "outbound",
      email_type: "offer",
      to_address: toAddress,
      subject,
      body,
      resend_message_id: resendMessageId,
      status,
    })
    .select("*")
    .single();

  if (logError) {
    // The email may have sent, but we couldn't record it — surface loudly.
    console.error("[send-offer] failed to write emails_log:", logError);
    throw new Error(`Failed to log email: ${logError.message}`);
  }

  // If the send itself failed, report failure after logging it.
  if (status === "failed") {
    throw new OfferSendError(sendErrorMessage ?? "Email send failed.");
  }

  return { emailLog: logRow as EmailLog };
}
