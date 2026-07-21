-- Migration: free-text intake + AI-extracted fields (Phase 4)
--
-- The form no longer collects service/size/postal/frequency via dropdowns.
-- Instead the customer writes a free-text request (raw_request) and Claude
-- extracts the structured fields afterwards. Those fields therefore become
-- nullable — they are AI-extracted, not form-guaranteed. We also record when
-- extraction couldn't determine enough to price the job.

-- 1. New columns.
--    raw_request          : the customer's own words (the only real form input).
--    property_size_m2     : the numeric m² Claude extracts. This is what the
--                           deterministic time_estimates lookup keys on; the
--                           legacy bucket column (property_size) is derived from
--                           it for display continuity.
--    needs_clarification  : true when service/size/location couldn't be
--                           determined, so a human should follow up.
alter table public.inquiries
  add column if not exists raw_request          text,
  add column if not exists property_size_m2     numeric,
  add column if not exists needs_clarification  boolean not null default false,
  add column if not exists clarification_reason text;

-- 2. Make the previously-required, form-guaranteed fields nullable.
alter table public.inquiries
  alter column service_type  drop not null,
  alter column property_size drop not null,
  alter column postal_code   drop not null,
  alter column frequency     drop not null;

-- 3. The old CHECK constraints reject NULL-friendly / free-form extracted values.
--    Postal code especially: extraction may leave it null. Drop the strict
--    checks; the enum-style checks below tolerate NULL (a CHECK passes on NULL).
alter table public.inquiries
  drop constraint if exists inquiries_postal_code_check;

-- Re-create the value checks so they still validate non-null extracted values
-- but allow NULL. (Dropping + re-adding is simplest and idempotent-ish; the
-- originals were added unconditionally in 0001.)
alter table public.inquiries
  drop constraint if exists inquiries_service_type_check,
  drop constraint if exists inquiries_property_size_check,
  drop constraint if exists inquiries_frequency_check;

alter table public.inquiries
  add constraint inquiries_service_type_check check (
    service_type is null or service_type in (
      'kotisiivous', 'muuttosiivous', 'toimistosiivous', 'ikkunanpesu',
      'suursiivous', 'erikoissiivous', 'porrassiivous'
    )
  ),
  add constraint inquiries_property_size_check check (
    property_size is null or property_size in (
      'alle_35', '35_49', '50_64', '65_79', '80_99',
      '100_119', '120_149', '150_199', '200_plus'
    )
  ),
  add constraint inquiries_frequency_check check (
    frequency is null or frequency in (
      'kertaluontoinen', 'viikoittain', 'joka_toinen_viikko', 'kuukausittain'
    )
  ),
  add constraint inquiries_postal_code_check check (
    postal_code is null or postal_code ~ '^\d{5}$'
  );
