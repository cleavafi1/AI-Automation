import crypto from "crypto";
import { getInboundResend } from "./email";

// Resend Inbound webhooks are signed with the Svix scheme. We verify the
// signature over the RAW request body before processing anything (Phase 7,
// safety rule): a failed check is rejected and logged, never processed.

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify a Svix-signed webhook. Signed content is `${id}.${timestamp}.${body}`,
 * HMAC-SHA256 with the base64 secret (after the `whsec_` prefix), base64-encoded.
 * The svix-signature header is a space-separated list of `v1,<sig>` entries.
 */
export function verifyResendSignature(params: {
  rawBody: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  secret: string;
}): boolean {
  const { rawBody, svixId, svixTimestamp, svixSignature, secret } = params;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Replay protection: reject timestamps more than 5 minutes from now.
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 60 * 5) return false;

  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  } catch {
    return false;
  }
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  const provided = svixSignature
    .split(" ")
    .map((entry) => (entry.includes(",") ? entry.split(",")[1] : entry));
  return provided.some((sig) => timingSafeEqualStr(sig, expected));
}

export type ResendInboundParsed = {
  toAddresses: string[];
  fromAddress: string;
  subject: string | null;
  bodyText: string;
  resendEmailId: string | null;
};

function addrList(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(addrList);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.address === "string") return [o.address];
    if (typeof o.email === "string") return [o.email];
  }
  return [];
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Flexibly parse a Resend inbound webhook payload into the fields we consume. */
export function parseResendInbound(payload: unknown): ResendInboundParsed | null {
  const p = payload as { data?: Record<string, unknown> } | null;
  const data = p?.data;
  if (!data || typeof data !== "object") return null;
  const text =
    typeof data.text === "string"
      ? data.text
      : typeof data.html === "string"
        ? stripHtml(data.html)
        : "";
  return {
    toAddresses: addrList(data.to),
    fromAddress: addrList(data.from)[0] ?? "",
    subject: typeof data.subject === "string" ? data.subject : null,
    bodyText: text,
    resendEmailId:
      typeof data.email_id === "string"
        ? data.email_id
        : typeof data.id === "string"
          ? data.id
          : null,
  };
}

/**
 * Fetch the full inbound email by id from the INBOUND Resend account (uses
 * RESEND_INBOUND_API_KEY via getInboundResend — NOT the sending key). The
 * webhook payload can arrive without the full body; this retrieves the complete
 * text/html and the address metadata.
 */
export async function fetchFullInboundEmail(
  emailId: string
): Promise<ResendInboundParsed | null> {
  const resend = getInboundResend();
  const { data, error } = await resend.emails.get(emailId);
  if (error) {
    throw new Error(`Resend inbound email fetch failed: ${error.message}`);
  }
  if (!data) return null;
  const d = data as unknown as Record<string, unknown>;
  const text =
    typeof d.text === "string"
      ? d.text
      : typeof d.html === "string"
        ? stripHtml(d.html)
        : "";
  return {
    toAddresses: addrList(d.to),
    fromAddress: addrList(d.from)[0] ?? "",
    subject: typeof d.subject === "string" ? d.subject : null,
    bodyText: text,
    resendEmailId: emailId,
  };
}

/**
 * The full inbound reply: the fetched body/metadata (authoritative) merged over
 * whatever the webhook payload carried, so a missing field on either side is
 * filled from the other. Falls back to the payload alone if the fetch is
 * unavailable (no key / API error) so a reply is never dropped.
 */
export async function resolveInbound(
  payloadParsed: ResendInboundParsed
): Promise<ResendInboundParsed> {
  if (!payloadParsed.resendEmailId || !process.env.RESEND_INBOUND_API_KEY) {
    return payloadParsed;
  }
  try {
    const full = await fetchFullInboundEmail(payloadParsed.resendEmailId);
    if (!full) return payloadParsed;
    return {
      toAddresses: full.toAddresses.length
        ? full.toAddresses
        : payloadParsed.toAddresses,
      fromAddress: full.fromAddress || payloadParsed.fromAddress,
      subject: full.subject ?? payloadParsed.subject,
      bodyText: full.bodyText || payloadParsed.bodyText,
      resendEmailId: payloadParsed.resendEmailId,
    };
  } catch (err) {
    console.error(
      "[email/inbound] full-body fetch failed; using webhook payload body:",
      err
    );
    return payloadParsed;
  }
}
