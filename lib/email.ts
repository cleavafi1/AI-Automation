import { Resend } from "resend";

// Server-side email sending via Resend. Not wired to any route yet — this is
// standalone plumbing. Lazily instantiated so missing env vars only fail when
// a send is actually attempted, not at build time.
let cachedClient: Resend | null = null;

function getResend(): Resend {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY environment variable.");
  }

  cachedClient = new Resend(apiKey);
  return cachedClient;
}

// Inbound replies (reply.cleava.fi) are verified under a SEPARATE Resend account
// from the sending domain (free tier = one domain per account, to be consolidated
// later). Fetching an inbound email's full body via the API must therefore use
// that account's own key — RESEND_INBOUND_API_KEY — not the sending key above.
let cachedInboundClient: Resend | null = null;

export function getInboundResend(): Resend {
  if (cachedInboundClient) return cachedInboundClient;

  const apiKey = process.env.RESEND_INBOUND_API_KEY;
  if (!apiKey) {
    throw new Error("Missing RESEND_INBOUND_API_KEY environment variable.");
  }

  cachedInboundClient = new Resend(apiKey);
  return cachedInboundClient;
}

// The sender address is read from the environment on every call — there is NO
// hardcoded fallback (e.g. onboarding@resend.dev). Set EMAIL_FROM_ADDRESS in
// the environment (e.g. info@cleava.fi) or sends throw.
function getFromAddress(): string {
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!from) {
    throw new Error("Missing EMAIL_FROM_ADDRESS environment variable.");
  }
  return from;
}

export type SendEmailParams = {
  to: string | string[];
  subject: string;
  // Provide at least one of html / text.
  html?: string;
  text?: string;
  replyTo?: string | string[];
};

export type SendEmailResult = {
  id: string;
};

/**
 * Send an email via Resend. The `from` address always comes from
 * EMAIL_FROM_ADDRESS — callers cannot override it and there is no default.
 */
export async function sendEmail(
  params: SendEmailParams
): Promise<SendEmailResult> {
  if (!params.html && !params.text) {
    throw new Error("sendEmail requires at least one of `html` or `text`.");
  }

  const resend = getResend();
  const from = getFromAddress();

  // Resend's types treat html / text as a mutually-exclusive union, so pass
  // exactly one as a definite string (the runtime guard above ensures one
  // exists). Prefer html when both are provided.
  const base = {
    from,
    to: params.to,
    subject: params.subject,
    replyTo: params.replyTo,
  };
  const { data, error } = await resend.emails.send(
    params.html !== undefined
      ? { ...base, html: params.html }
      : { ...base, text: params.text as string }
  );

  if (error) {
    // Surface the real Resend error to the caller / server logs.
    throw new Error(`Resend send failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("Resend returned no data and no error.");
  }

  return { id: data.id };
}
