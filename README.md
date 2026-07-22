# Cleava AI Booking Agent — Phase 1

Standalone booking/inquiry system for Cleava (Mansio Group Oy). Phase 1 delivers a
single-page inquiry form that saves real-shaped submissions to Supabase, plus a
seeded `pricing_tiers` reference table for the Phase 2 quote logic.

**Stack:** Next.js 14 (App Router) · TypeScript · Tailwind CSS · Supabase (Postgres)

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create a Supabase project** at https://supabase.com and grab the API keys
   (Project Settings → API).

3. **Configure env vars.** Copy the example and fill in your values:
   ```bash
   cp .env.example .env.local
   ```
   | Variable | Where | Notes |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL | |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key (`sb_publishable_...`) | Not used by Phase 1 code yet; reserved for Phase 2. OK to leave blank. |
   | `SUPABASE_SECRET_KEY` | Secret key (`sb_secret_...`) | **Server only.** Never expose to the client. |
   | `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | **Server only.** Used by Phase 2 quote generation. |

4. **Run the migrations.** In the Supabase dashboard → SQL Editor, run the files in
   `supabase/migrations/` **in order**:
   - `0001_create_inquiries.sql`
   - `0002_create_pricing_tiers.sql`
   - `0003_seed_pricing_tiers.sql`
   - `0004_create_quotes.sql` (Phase 2)
   - `0005_create_emails_log.sql` (Phase 3)

   (Or, if you use the Supabase CLI: `supabase db push`.)

5. **Start the dev server**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000, submit the form, and confirm a row lands in the
   `inquiries` table.

## What's here

- `app/page.tsx` — inquiry form page (Finnish labels).
- `components/InquiryForm.tsx` — client form with inline validation.
- `app/api/inquiries/route.ts` — `POST /api/inquiries`; server-side validation
  (Zod) then insert. Returns the confirmation message on success; logs the real
  error server-side and returns a generic message on failure.
- `lib/constants.ts` — shared enums + Finnish labels (form ↔ validation ↔ DB).
- `lib/validation.ts` — Zod schema (source of truth for server validation).
- `lib/supabase.ts` — server-side Supabase admin client (service role).
- `supabase/migrations/` — schema + seed SQL.

## Data model

**`inquiries`** — form submissions. Enum values are enforced by DB `CHECK`
constraints and match `lib/constants.ts`. `city` is nullable (inferred from postal
code later); `status` defaults to `'new'`. RLS is enabled with no policies, so only
the service-role API route can read/write.

**`pricing_tiers`** — static reference data, seeded now, read by Phase 2 logic.

## Phase 2 — AI quote drafting

Generates an internal, Finnish-language quote draft per inquiry. **Nothing is
sent to a customer** — drafts are saved to `quotes` for review only.

- `lib/pricing.ts` — deterministic pricing resolver. Reads `pricing_tiers` and
  works out the applicable rate for an inquiry (frequency-keyed for kotisiivous,
  single-rate for the other hourly services, quote-only for office/stairwell/
  special). Price math lives here, never in the model.
- `lib/quote.ts` — the generation logic. Loads inquiry + pricing, calls Claude
  (**Opus 4.8**, adaptive thinking, structured JSON output) to classify the
  request, spot unusual notes, and draft the Finnish text. Then:
  - **Price** = `base_rate × estimated_hours` (min 2h), computed in code.
  - **Flags** (`is_flagged`) — set when the service is quote-only
    (toimistosiivous/porrassiivous/erikoissiivous), when a normally-hourly
    service has no fixed rate (e.g. one-time kotisiivous), when notes look
    unusual (pets, access, disputes, special requests), or when the model
    classifies the request as `needs_review`. `flag_reason` aggregates the why.
  - **kotitalousvähennys** (35%, max €1,600/yr) is mentioned only for home
    services (kotisiivous, muuttosiivous, suursiivous, ikkunanpesu).
- `app/api/inquiries/[id]/generate-quote/route.ts` — `POST` manual trigger.
  **Not** called automatically on form submit.
- `app/internal/quotes/page.tsx` — throwaway `/internal/quotes` table (no auth,
  local only) listing every generated quote with inquiry summary, drafted text,
  flag status/reason, and price.

### Testing Phase 2

1. Fill `ANTHROPIC_API_KEY` in `.env.local` and restart `npm run dev`.
2. Submit the form (or grab an existing row) and copy an inquiry `id` from the
   Supabase `inquiries` table.
3. Trigger generation:
   ```bash
   curl -X POST http://localhost:3000/api/inquiries/<inquiry-id>/generate-quote
   ```
4. Open http://localhost:3000/internal/quotes to review the draft, flag, and price.

Try a spread: a weekly kotisiivous (fixed rate → price), a one-time kotisiivous
(no fixed rate → flagged), a toimistosiivous (quote-only → flagged, no price),
and one with unusual notes (e.g. "meillä on kaksi koiraa" → flagged).

## Phase 3 — manual offer sending

Sends an approved quote to the customer by email (Resend), logged to
`emails_log`. Triggered manually from the internal page — no auto-send.

- `lib/email.ts` — the Resend plumbing. `sendEmail({ to, subject, text | html })`
  reads `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS` from env (no hardcoded sender).
- `lib/send-offer.ts` — `sendOfferForQuote(quoteId)`: loads the quote + inquiry,
  requires `status = 'approved'`, sends the quote's `drafted_text` as a **plain
  text** email to the inquiry's address, and logs the outcome to `emails_log`
  (with Resend's message id on success, or a `status = 'failed'` row + the real
  error server-side on failure).
- `app/api/quotes/[id]/approve/route.ts` — `POST`, sets `status = 'approved'`.
- `app/api/quotes/[id]/send-offer/route.ts` — `POST`, sends the offer; returns a
  clear **409** if the quote isn't approved.
- `/internal/quotes` — each row has an **Approve & send** button (client
  component). It approves, then sends. **Flagged quotes** show an amber button
  and require an explicit confirm dialog before sending. A "Send offer" column
  shows the last send status (recipient + timestamp, or a failed marker).

Env vars (`.env.local`): `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS=info@cleava.fi`.
Run migration `0005_create_emails_log.sql` before testing.

### Testing Phase 3
1. Ensure `RESEND_API_KEY` + `EMAIL_FROM_ADDRESS` are set and migration `0005`
   is applied; restart `npm run dev`.
2. Generate a quote (Phase 2), open `/internal/quotes`, and click **Approve &
   send** on a row. For a flagged row, confirm the dialog.
3. Check the customer inbox and the `emails_log` table for the logged send.

## Admin dashboard + auth

Real, login-protected admin UI at `/admin` — replaces the old throwaway
`/internal/quotes` (which now redirects to `/admin`).

- **Auth** — session-based, single admin account, no third-party library.
  - `lib/auth.ts` — signed session cookie (HMAC-SHA256), create/verify.
  - `app/api/admin/login` / `logout` — verify credentials (bcrypt) / clear cookie.
  - `app/admin/login` — login form. `app/admin/(protected)/layout.tsx` guards
    every other `/admin/*` route server-side and **fails closed** (redirects to
    login on any missing/invalid session).
- **Dashboard** — `app/admin/(protected)/page.tsx`: quote cards with status
  badges (draft = gray, approved = blue, sent = green, failed = red), flagged
  quotes get an amber left border + badge, expandable full quote/inquiry detail,
  All / Flagged only / Sent filter tabs, and the "Showing N of M" count safety.
  The **Approve & send** button and flagged-confirm behavior are unchanged from
  Phase 3 — restyled only.

### Setup

Add to `.env.local`:
```
ADMIN_EMAIL=you@cleava.fi
ADMIN_PASSWORD_HASH=<output of the script below>
ADMIN_SESSION_SECRET=<random secret>
```
- **Password hash** — run `node scripts/hash-password.mjs "your-password"` and
  paste the output. It's a bcrypt hash, **base64-encoded**: a raw bcrypt hash
  contains `$` characters that Next.js's dotenv-expand corrupts (silently
  breaking login), so base64 is required. The script emits the correct form.
- **Session secret** —
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Restart `npm run dev`, then visit `/admin` (redirects to `/admin/login` until
you sign in).

## Phase 4 — free-text intake + real estimation data

The form no longer asks the customer to pick service/size/frequency. It collects
just **Nimi, Sähköposti, Puhelinnumero** and one free-text field ("Kerro lyhyesti
mitä toivot…"). Claude then **extracts** the structured fields from that text, and
a deterministic lookup produces the hour + price estimate.

- **Form** — `components/InquiryForm.tsx`: four fields, no dropdowns.
  `lib/validation.ts` validates name/email/phone/`raw_request` only.
- **Schema** (`0006`) — `inquiries` gains `raw_request`, `property_size_m2`,
  `needs_clarification` (default false), `clarification_reason`. The AI-extracted
  fields `service_type` / `property_size` / `postal_code` / `frequency` become
  **nullable** (their CHECK constraints now also allow NULL).
- **Pricing fix** (`0007`) — kotisiivous is a single **flat 39 €/h** (the old
  39/45/49 frequency tiers are gone). ikkunanpesu 39, suursiivous 40,
  muuttosiivous 42 unchanged. `lib/pricing.ts` no longer frequency-keys
  kotisiivous.
- **`time_estimates`** (`0008` schema, `0009` seed) — reference table of
  size-bracket → **single-cleaner** hour ranges (`hours_min_1c`,
  `hours_max_1c`) for kotisiivous, ikkunanpesu, muuttosiivous. We always assume
  **1 cleaner** — there is no cleaner-count logic anywhere.
- **Extraction** — `lib/extraction.ts`:
  - `extractFromRequest(raw)` — a **separate** Claude call (structured JSON)
    that pulls out service type, `property_size_m2`, postal code, city,
    preferred time, frequency and condition notes. **Never invents a value** —
    unknowns come back null. `needs_clarification` is then derived **in code**:
    true when service type, size, or location (postal code *or* city) is missing.
  - `computeEstimate(...)` — **deterministic** (no model): looks up the matching
    `time_estimates` bracket for the extracted service+m², applies the 2h floor,
    and multiplies by the `pricing_tiers` rate to get a price range. Services with
    a rate but no bracket (e.g. suursiivous) fall back to the size-bucket default.
- **Flow** — `lib/quote.ts` runs extraction first, persists the extracted fields
  back onto the inquiry (so `/admin` shows them), then drafts the quote **fed by
  extracted data** instead of dropdown values. `needs_clarification` adds a flag
  reason; the drafter is told to ask the customer to complete missing details
  rather than price an uncertain job. Everything else (flag logic,
  kotitalousvähennys rules, Resend send) is unchanged.
- **Admin** — inquiry cards show the raw request, extracted m², a "Needs
  clarification" badge, and the clarification reason.

### Testing Phase 4

1. Apply migrations `0006`–`0009` (0009 is the `time_estimates` seed).
2. Submit the free-text form (e.g. *"Tarvitsen kotisiivousta 65 neliön asuntoon
   Helsingissä, meillä on kissa, mieluiten ensi viikolla"*).
3. Watch the background quote generate, then open `/admin`: confirm the extracted
   service/size/location, the deterministic hour+price estimate, and — for a
   vague request missing size/service/location — the **Needs clarification** flag.

## Phase 5 — Google Calendar availability + booking rules

After estimating hours/price, the pipeline checks the real Google Calendar and
proposes an appointment slot that satisfies deterministic booking rules. On
approval it re-checks and places a **tentative** hold. Nothing is auto-confirmed.

- **Env** — `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (the full service-account JSON,
  base64-encoded — decoded at runtime, never stored raw; same pattern as
  `ADMIN_PASSWORD_HASH`) and `GOOGLE_CALENDAR_ID`. Share the calendar with the
  service account's `client_email` ("Make changes to events").
- **`lib/timezone.ts`** — Europe/Helsinki wall-clock ⇆ UTC helpers (DST-correct
  via `Intl`). All booking math is done in Helsinki time regardless of server tz.
- **`lib/calendar.ts`** — `googleapis` JWT/service-account client (scope
  `…/auth/calendar`). `listEvents(min,max)` and `createTaggedEvent(...)`. Every
  event we create carries `extendedProperties.private.source = "cleava-agent"`.
- **`lib/locations.ts`** — hardcoded Uusimaa lookup (Helsinki/Espoo/Vantaa/
  Kauniainen/Kirkkonummi/Kerava/Järvenpää/Tuusula/Sipoo/Nurmijärvi = Uusimaa;
  Jyväskylä/Kuokkala/Palokka/Vaajakoski/Muurame = not), city first with a
  postal-prefix backstop. Unknown → defaults to Uusimaa (conservative).
- **`lib/booking.ts`** — the deterministic rules engine (no AI):
  - Working window **08:00–18:00**; the full estimated duration (scheduled
    against the **max** hour estimate) must fit before 18:00.
  - No overlap with any existing timed event.
  - **Uusimaa**: 1-hour travel gap before/after neighbouring events.
  - **Max 5 cleaning appointments/day**. Counting pre-existing entries is a
    **best-effort keyword heuristic** (siivous/kotisiivous/muuttosiivous/
    ikkunanpesu/tehopuhdistus/suursiivous) — a documented limitation on
    inconsistently-named historical data. Our own events are counted **exactly**
    via the `source: cleava-agent` tag, so going forward counting is reliable.
  - `findNearestAvailableSlot(...)` — **forward-only** when a date was
    requested: it never proposes a slot earlier than the customer's requested
    day. If the requested day has no valid slot, it searches later days only
    (never back to an earlier day, even if an earlier slot is closer in absolute
    time), ~21 days out. When no date was requested (fully open-ended), it falls
    back to the nearest upcoming slot from now.
- **Extraction** — now also returns a **concrete** `requested_date`/
  `requested_time` (only when clearly resolvable; vague terms stay null). Given
  today's Helsinki date, "ensi maanantaina" resolves; "pian" does not.
- **Quotes** (`0010`) — `proposed_date`, `proposed_start_time`,
  `proposed_end_time`, `calendar_event_id`. The drafting prompt phrases the slot
  strictly as an **"ehdotettu aika"** (proposal requiring confirmation) — never
  "varattu"/"vahvistettu".
- **Tentative hold on approval** — the `/admin` **Approve & send** flow now,
  after approving and **before** sending, re-checks the calendar one final time
  (a slot can fill between generation and approval). If still free it creates a
  tentative event `Tentative – [Name] – Quote awaiting acceptance` (tagged) and
  stores its id; the client then sends. If the slot is gone it returns **409**
  and the offer is **not** sent — the error surfaces in `/admin` for a manual
  re-check. Idempotent: a stored `calendar_event_id` prevents duplicate events on
  resend.

Calendar failures at generation time never break quoting — the proposed slot is
simply left empty and the quote is still produced (and sendable).

### Testing Phase 5

1. Add `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` + `GOOGLE_CALENDAR_ID` to
   `.env.local`, share the calendar with the service account, apply migration
   `0010`, restart.
2. Submit a request with a concrete time (e.g. *"...ensi torstaina klo 10"*) and
   generate the quote (Approve/Generate in `/admin`). Confirm the drafted text
   proposes the time as *ehdotettu aika* and the card shows the proposed slot.
3. In `/admin` click **Approve & send** → a tentative event appears on the
   calendar and the card shows "Tentative hold placed". Manually create a
   conflicting event on the proposed slot first to verify the **409 / not sent**
   path.

## Phase 6 — Telegram staff approval flow

Every generated quote is pushed to a staff Telegram chat with **✅ Approve /
❌ Decline / ✏️ Custom** buttons. Approve reuses the exact `/admin` "Approve &
send" logic; Custom opens an AI edit loop. `/admin` is unchanged and still works.

- **Env** — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_STAFF_CHAT_ID` (only updates from
  that chat are honored), and optional `TELEGRAM_WEBHOOK_SECRET`.
- **`lib/telegram.ts`** — Bot API client (fetch-based, no dependency):
  `sendMessage`, `answerCallbackQuery`, `clearButtons`, the 3-button keyboard,
  and the staff notification body (name, service, size, location, price or
  "quote-only", proposed slot or "no slot found", flag reason, drafted text).
- **Notification** — sent at quote generation (`lib/quote.ts`, same trigger as
  the calendar step); the Telegram `message_id` is stored on the quote. A
  Telegram outage never breaks generation.
- **Schema** (`0011`) — `quotes.telegram_message_id`, `quotes.decline_reason`,
  the `'declined'` status, and `telegram_pending_edits (chat_id, quote_id, kind,
  created_at)` — the stateless webhook uses this to know a follow-up text is an
  edit instruction (`kind='edit'`) or a decline reason (`kind='decline_reason'`).
- **Webhook** — `POST /api/telegram/webhook` (register with
  `node scripts/telegram-set-webhook.mjs https://<host>/api/telegram/webhook`).
  Always returns 200 (Telegram retries non-2xx); handlers surface errors back to
  the chat. Handles button presses and text messages.
  - **Approve** → `lib/approve-send.ts` `approveAndSend()` composes the existing
    `placeTentativeHold` + `sendOfferForQuote` (final calendar re-check →
    tentative hold → send; refuses + reverts if the slot is gone). Not duplicated.
  - **Decline** → status `'declined'`, asks for an optional reason, stores the
    next text as `decline_reason`. No customer email.
  - **Custom** → asks for changes in plain language, then `lib/telegram-edit.ts`
    sends the instruction + current draft to Claude, which rewrites the text
    **changing only what was asked** and preserving every other fact. If the
    date/time changed, availability is **re-checked** for the new slot. The
    revised draft is sent back with the same three buttons — the loop continues
    until Approve or Decline. The pending row is claimed (deleted) before the
    Claude call so a Telegram retry can't double-process.
- **`scripts/telegram-set-webhook.mjs`** — registers/clears the webhook.

### Testing Phase 6

1. Create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_STAFF_CHAT_ID`,
   apply migration `0011`, deploy, then run the setWebhook script.
2. Generate a quote → a Telegram message with the three buttons appears.
3. Press **✏️ Custom**, send e.g. *"muuta hinta 180 €:oon ja siirrä perjantaille
   klo 12"* → the revised draft comes back with buttons (edit loop). Press
   **✅ Approve** → offer emailed + tentative hold placed, or **❌ Decline** →
   status declined and it asks for a reason.

## Out of scope (Phase 6)

WhatsApp (later swap-in once Meta verification clears), customer-side acceptance
handling (Phase 7).

## Out of scope (admin phase)

Password reset, multiple admin users/roles, an inquiries-only view, and Phase 4
booking/reminders. Backend send pipeline (approve / send-offer / emails_log) is
unchanged.

## Out of scope (Phase 3)

Real admin dashboard with auth, auto-trigger on form submit or quote generation,
inbound email handling, booking/reminder scheduling, and HTML email templates
(plain text for now).
