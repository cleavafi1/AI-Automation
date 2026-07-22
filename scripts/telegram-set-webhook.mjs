// Register (or clear) the Telegram webhook.
//
// Usage:
//   node scripts/telegram-set-webhook.mjs https://<host>/api/telegram/webhook
//   node scripts/telegram-set-webhook.mjs --delete
//
// Reads TELEGRAM_BOT_TOKEN (and optional TELEGRAM_WEBHOOK_SECRET) from the
// environment or .env.local.

import fs from "node:fs";

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  } catch {
    /* no .env.local — rely on process.env */
  }
  return env;
}

const env = loadEnv();
const token = env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN.");
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  console.error(
    "Usage: node scripts/telegram-set-webhook.mjs <https-url> | --delete"
  );
  process.exit(1);
}

const base = `https://api.telegram.org/bot${token}`;

async function main() {
  if (arg === "--delete") {
    const r = await fetch(`${base}/deleteWebhook`, { method: "POST" });
    console.log("deleteWebhook:", JSON.stringify(await r.json()));
    return;
  }

  const body = {
    url: arg,
    allowed_updates: ["message", "callback_query"],
  };
  if (env.TELEGRAM_WEBHOOK_SECRET) body.secret_token = env.TELEGRAM_WEBHOOK_SECRET;

  const r = await fetch(`${base}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log("setWebhook:", JSON.stringify(await r.json()));

  const info = await fetch(`${base}/getWebhookInfo`).then((x) => x.json());
  console.log("getWebhookInfo:", JSON.stringify(info));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
