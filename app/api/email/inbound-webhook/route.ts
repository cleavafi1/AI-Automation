import { NextResponse } from "next/server";
import {
  verifyResendSignature,
  parseResendInbound,
  resolveInbound,
} from "@/lib/resend-inbound";
import { quoteIdFromReplyAddress } from "@/lib/reply-address";
import { processInboundReply } from "@/lib/reply-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Resend Inbound webhook (Phase 7). Every inbound customer reply lands here.
// SAFETY: the raw body is signature-verified with RESEND_WEBHOOK_SECRET before
// anything is processed; a failed check is rejected (401) and logged, never
// processed. Nothing here emails the customer — it only classifies + drafts and
// posts to Telegram for an explicit staff Approve.
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[email/inbound] RESEND_WEBHOOK_SECRET not set — rejecting.");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  // Read the RAW body for signature verification (must match byte-for-byte).
  const rawBody = await request.text();
  const verified = verifyResendSignature({
    rawBody,
    svixId: request.headers.get("svix-id"),
    svixTimestamp: request.headers.get("svix-timestamp"),
    svixSignature: request.headers.get("svix-signature"),
    secret,
  });
  if (!verified) {
    console.error("[email/inbound] signature verification FAILED — rejecting.");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const payloadParsed = parseResendInbound(payload);
  if (!payloadParsed) {
    return NextResponse.json({ ok: true, note: "no parseable data" }, { status: 200 });
  }

  // Fetch the full email body from the INBOUND Resend account (separate key)
  // and merge it over the webhook payload — the payload can omit the full body.
  const parsed = await resolveInbound(payloadParsed);

  // Map the reply to its quote via the reply-to address (quote-{id}@reply…).
  const quoteId =
    parsed.toAddresses.map(quoteIdFromReplyAddress).find(Boolean) ?? null;
  if (!quoteId) {
    console.error(
      "[email/inbound] no quote-*@ recipient matched:",
      parsed.toAddresses
    );
    return NextResponse.json({ ok: true, note: "unmatched recipient" }, { status: 200 });
  }

  try {
    const result = await processInboundReply({
      quoteId,
      fromAddress: parsed.fromAddress,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      resendEmailId: parsed.resendEmailId,
    });
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (err) {
    // Log and return 200 so Resend doesn't retry-storm; the reply is recorded.
    console.error("[email/inbound] processing failed:", err);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
