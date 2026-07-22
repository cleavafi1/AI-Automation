// Per-quote reply-to addressing for the conversational email loop (Phase 7).
//
// IMPORTANT: replies are handled on a DEDICATED subdomain (reply.cleava.fi),
// never the root cleava.fi — the root's MX records run ImprovMX for Cleava's
// real inbox and must not be touched. Resend Inbound owns this subdomain only.
export const REPLY_EMAIL_DOMAIN =
  process.env.REPLY_EMAIL_DOMAIN?.trim() || "reply.cleava.fi";

/**
 * The reply-to address for a quote's customer emails. Every inbound reply lands
 * on this address, so the quote id is recoverable directly from the recipient —
 * no fuzzy subject-line matching.
 */
export function replyToAddressForQuote(quoteId: string): string {
  return `quote-${quoteId}@${REPLY_EMAIL_DOMAIN}`;
}

/**
 * Whether inbound reply handling is live. We only advertise the reply-to once
 * the inbound webhook is configured — otherwise reply.cleava.fi has no MX yet
 * and customer replies would bounce instead of reaching info@cleava.fi. Keyed on
 * RESEND_WEBHOOK_SECRET, which is set as the final step of enabling Resend
 * Inbound (see .env.example / the Phase 7 go-live checklist).
 */
export function inboundRepliesEnabled(): boolean {
  return Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim());
}

/**
 * The reply-to header value to use on an outgoing email, or undefined when
 * inbound handling isn't configured yet (so the email carries no reply-to and
 * replies fall back to the From address, exactly as before Phase 7).
 */
export function replyToIfEnabled(quoteId: string): string | undefined {
  return inboundRepliesEnabled() ? replyToAddressForQuote(quoteId) : undefined;
}

/**
 * Recover the quote id from an inbound "to" address. Accepts a bare address or
 * a "Name <addr>" form. Returns null when it doesn't match our pattern.
 */
export function quoteIdFromReplyAddress(toAddress: string): string | null {
  const m = /quote-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})@/.exec(
    toAddress
  );
  return m ? m[1].toLowerCase() : null;
}
