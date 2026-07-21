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

## Out of scope (admin phase)

Password reset, multiple admin users/roles, an inquiries-only view, and Phase 4
booking/reminders. Backend send pipeline (approve / send-offer / emails_log) is
unchanged.

## Out of scope (Phase 3)

Real admin dashboard with auth, auto-trigger on form submit or quote generation,
inbound email handling, booking/reminder scheduling, and HTML email templates
(plain text for now).
