# Cleava AI Booking Agent — handoff / onboarding prompt

Paste this into a fresh Claude Code session in the new environment so it
understands the project state.

---

You are picking up an existing project: the **Cleava AI Booking Agent** (Mansio
Group Oy), a Next.js 14 app that turns a free-text cleaning inquiry into an
AI-drafted quote, proposes a calendar slot, and routes it to staff for approval
by email + Telegram. Phases 1–6 plus an estimation enhancement are already built
and deployed. Read `README.md` for the full per-phase detail; this is the
condensed state + how to continue.

## Stack & deploy
- Next.js 14 (App Router) · TypeScript · Tailwind · Supabase (Postgres) ·
  Anthropic SDK (Claude **Opus 4.8** for drafting, model id `claude-opus-4-8`;
  the code currently uses `QUOTE_MODEL` in `lib/anthropic.ts`) · Resend (email) ·
  googleapis (Calendar) · Telegram Bot API.
- **GitHub:** `cleavafi1/AI-Automation`, default branch `main` (the user pushes
  straight to `main`, no PRs).
- **Deploy:** Netlify — https://reliable-souffle-5e3ac5.netlify.app . Netlify
  auto-deploys on push to `main`. Quote generation runs in a **Netlify
  background function** (`netlify/functions/generate-quote-background.mts`, 15-min
  budget) because a full generation takes ~1–2 min — synchronous API routes time
  out at Netlify's ~26s gateway limit (this caused earlier 502/504s).

## Environment (secrets live in `.env.local`, which is GITIGNORED)
Copy `.env.local` from the old machine — it is NOT in git. Names (see
`.env.example`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` (base64'd bcrypt), `ADMIN_SESSION_SECRET`,
`GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (base64'd service-account JSON, decoded at
runtime), `GOOGLE_CALENDAR_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_STAFF_CHAT_ID`,
optional `TELEGRAM_WEBHOOK_SECRET`. Same vars must be set in Netlify env.
**Never commit secrets** (a base64 key was leaked once via `git add -A` — always
stage explicit files).

## Database
Supabase Postgres. Apply migrations `supabase/migrations/0001` … `0011` **in
order** in the SQL editor. `0011` (Telegram) is the newest. If quote generation
500s with "column not found", a migration hasn't been applied.

## Architecture / data flow
1. Public form (`components/InquiryForm.tsx`) collects name/email/phone + one
   free-text `raw_request`. `POST /api/inquiries` saves it and fires the
   background function.
2. `lib/quote.ts` `generateQuoteForInquiry`:
   - `lib/extraction.ts` — Claude call extracts service, `property_size_m2`,
     location, concrete `requested_date`/`requested_time` (never invents; unknowns
     → null → `needs_clarification`).
   - Deterministic estimate (`computeEstimate`): hour range from `time_estimates`
     (seeded from the client's PDF), price = total hours × `pricing_tiers` rate;
     **cleaner count** by size (<30 m²=1, 30–<100=2, 100+=3), **finish time** =
     total ÷ cleaners, **net price** after kotitalousvähennys (35%).
   - Calendar (`lib/booking.ts` + `lib/calendar.ts`): proposes the nearest slot
     satisfying deterministic rules (08:00–18:00 Europe/Helsinki, no overlap, 1h
     Uusimaa travel gap, max 5 cleaning/day). **Forward-only** from the requested
     day. Reserves the **finish time** (total ÷ cleaners). Timezone math in
     `lib/timezone.ts`.
   - Claude drafts the customer-facing Finnish text (proposal wording only —
     "ehdotettu aika", never "varattu"), includes cleaner count, finish time,
     gross+net price, and a ">30 m² may need +1–2h, always announced beforehand,
     no piilokulu" caveat.
   - Persists the quote; notifies staff on Telegram with Approve/Decline/Custom.
3. Approval: `/admin` (login-protected) **and** Telegram both approve → final
   calendar re-check + tentative hold event + Resend email. Shared logic in
   `lib/approve-send.ts` / `lib/tentative-hold.ts` / `lib/send-offer.ts`.
4. Telegram edit loop (`lib/telegram-webhook.ts` + `lib/telegram-edit.ts`):
   "Custom" → Claude rewrites only what's asked, re-checks calendar if the
   date/time changed, resends with buttons; loops until Approve/Decline.

## Current outstanding items
- **Telegram token is malformed** in the old `.env.local` (had spaces:
  `8987161809: AAGUr As …`). Re-copy from @BotFather as one unbroken string.
- **Register the Telegram webhook from the server** (the user's network blocks
  api.telegram.org, so `setWebhook` from a laptop times out). After deploying
  with a valid token, open while logged into `/admin`:
  `https://reliable-souffle-5e3ac5.netlify.app/api/telegram/setup`
  (Netlify reaches Telegram and registers `…/api/telegram/webhook`).
- The **live Telegram round-trip has not been tested end-to-end** yet (blocked on
  the token). Everything else is verified.

## Known gotchas
- The Google calendar's display timezone is UTC+5 (Asia/Karachi), but events are
  returned with explicit offsets and all booking math is in Europe/Helsinki —
  instants are correct; only the *display* differs.
- Local `next dev` has no Netlify background function, so the manual "Generate
  quote" button and background auto-trigger behave differently; the manual route
  runs synchronously locally and dispatches the background fn on Netlify.
- Telegram is blocked on the user's local network — you can't call the Bot API
  from the dev machine; test Telegram against the deployed site.
- The Anthropic base URL and Supabase/Resend/Google are all reachable locally.

## How to run / verify
- `npm install`; `npm run dev` → http://localhost:3000 . `/admin` is the
  dashboard (needs the admin env vars). `npx tsc --noEmit` and `npx next build`
  should both be clean.
- To test a phase change locally, generate a quote via the `/admin` "Generate
  quote" button (runs synchronously in dev) and inspect the drafted text +
  `quotes` row in Supabase.

## Out of scope (next up = Phase 7)
Customer-side acceptance handling (tentative → confirmed when the customer
replies), and a WhatsApp swap-in for Telegram once Meta verification clears.
