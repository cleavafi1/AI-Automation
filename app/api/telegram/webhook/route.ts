import { NextResponse } from "next/server";
import { processTelegramUpdate } from "@/lib/telegram-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Telegram webhook endpoint. Register it once with:
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<host>/api/telegram/webhook&secret_token=<SECRET>"
//
// Telegram retries on any non-2xx, so we ALWAYS return 200 — errors are handled
// inside processTelegramUpdate and surfaced back to the chat, never as an HTTP
// error. An optional shared secret (TELEGRAM_WEBHOOK_SECRET) is verified via the
// X-Telegram-Bot-Api-Secret-Token header when set.
export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const got = request.headers.get("x-telegram-bot-api-secret-token");
    if (got !== secret) {
      // Silently accept but ignore — don't reveal the check to callers.
      return NextResponse.json({ ok: true }, { status: 200 });
    }
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  try {
    await processTelegramUpdate(update);
  } catch (err) {
    // Last-resort guard — should not happen (handlers swallow their own errors).
    console.error("[telegram/webhook] unhandled error:", err);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
