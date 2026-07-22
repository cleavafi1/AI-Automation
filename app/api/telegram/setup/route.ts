import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { setWebhook, getWebhookInfo } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-time webhook registration, run FROM the server (Netlify can reach
// api.telegram.org even when your local network can't). Admin-session protected.
//
// Visit while logged into /admin:
//   GET  /api/telegram/setup            → registers <origin>/api/telegram/webhook
//   GET  /api/telegram/setup?info=1     → just shows current getWebhookInfo
export async function GET(request: Request) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  const { searchParams, origin } = new URL(request.url);

  try {
    if (searchParams.get("info")) {
      return NextResponse.json({ webhookInfo: await getWebhookInfo() });
    }
    // Prefer the deployed site URL if Netlify provides it; else the request origin.
    const base = (process.env.URL || origin).replace(/\/$/, "");
    const webhookUrl = `${base}/api/telegram/webhook`;
    const setResult = await setWebhook(webhookUrl);
    const info = await getWebhookInfo();
    return NextResponse.json({ webhookUrl, setResult, webhookInfo: info });
  } catch (err) {
    console.error("[telegram/setup] failed:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to register webhook.",
      },
      { status: 502 }
    );
  }
}
