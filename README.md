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
   | Variable | Where |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key (server only) |

4. **Run the migrations.** In the Supabase dashboard → SQL Editor, run the files in
   `supabase/migrations/` **in order**:
   - `0001_create_inquiries.sql`
   - `0002_create_pricing_tiers.sql`
   - `0003_seed_pricing_tiers.sql`

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

## Out of scope (Phase 1)

AI/quote logic, email sending, admin dashboard, kotitalousvähennys calculations,
and any auto-send beyond the on-screen confirmation.
