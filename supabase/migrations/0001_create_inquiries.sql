-- Migration: create inquiries table
-- Stores customer booking/inquiry submissions from the Cleava form.

create extension if not exists "pgcrypto";

create table if not exists public.inquiries (
  id            uuid primary key default gen_random_uuid(),
  service_type  text not null,
  property_size text not null,
  postal_code   text not null,
  city          text,
  frequency     text not null,
  name          text not null,
  email         text not null,
  phone         text not null,
  notes         text,
  status        text not null default 'new',
  created_at    timestamptz not null default now(),

  constraint inquiries_service_type_check check (
    service_type in (
      'kotisiivous', 'muuttosiivous', 'toimistosiivous', 'ikkunanpesu',
      'suursiivous', 'erikoissiivous', 'porrassiivous'
    )
  ),
  constraint inquiries_property_size_check check (
    property_size in (
      'alle_35', '35_49', '50_64', '65_79', '80_99',
      '100_119', '120_149', '150_199', '200_plus'
    )
  ),
  constraint inquiries_frequency_check check (
    frequency in (
      'kertaluontoinen', 'viikoittain', 'joka_toinen_viikko', 'kuukausittain'
    )
  ),
  constraint inquiries_postal_code_check check (postal_code ~ '^\d{5}$')
);

create index if not exists inquiries_created_at_idx on public.inquiries (created_at desc);
create index if not exists inquiries_status_idx on public.inquiries (status);

-- Row Level Security: enabled with no policies, so only the service role
-- (used server-side by the API route) can read/write. The public anon key
-- cannot touch this table directly.
alter table public.inquiries enable row level security;
