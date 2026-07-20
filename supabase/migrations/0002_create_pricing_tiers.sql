-- Migration: create pricing_tiers table
-- Static reference data read by the AI/quote logic in Phase 2.

create extension if not exists "pgcrypto";

create table if not exists public.pricing_tiers (
  id            uuid primary key default gen_random_uuid(),
  service_type  text not null,
  tier_label    text,
  rate_type     text not null,
  base_rate_eur numeric,
  notes         text,

  constraint pricing_tiers_rate_type_check check (
    rate_type in ('hourly', 'quote_only')
  )
);

create index if not exists pricing_tiers_service_type_idx
  on public.pricing_tiers (service_type);

-- Reference data. Enable RLS; a read-only policy could be added later if the
-- client ever needs direct access. For now Phase 2 logic reads it server-side.
alter table public.pricing_tiers enable row level security;
