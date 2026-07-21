-- Migration: create time_estimates reference table (Phase 4).
--
-- Size-bracket → on-site hour ranges from Cleava's estimation guide, used to
-- deterministically estimate labour hours once Claude has extracted the service
-- type and approximate m². We only model a SINGLE cleaner (1c) — no
-- cleaner-count logic anywhere in the system. Hours are then multiplied by the
-- pricing_tiers rate to produce a price range, all in code (never the model).
--
-- Brackets are matched INCLUSIVE-LOWER in code (see lib/extraction.ts): a row
-- matches on (size_min_m2, size_max_m2], with a fallback so the smallest bracket
-- also includes its own min. Seed brackets are contiguous and share endpoints
-- (…20–30, 30–40…); a boundary value lands in the LOWER bracket (30 → 20–30).
-- Sizes above the largest max fall through to the size-bucket fallback in code.

create extension if not exists "pgcrypto";

create table if not exists public.time_estimates (
  id            uuid primary key default gen_random_uuid(),
  service_type  text    not null,
  size_min_m2   numeric not null,
  size_max_m2   numeric not null,
  hours_min_1c  numeric not null,
  hours_max_1c  numeric not null,

  constraint time_estimates_service_type_check check (
    service_type in ('kotisiivous', 'ikkunanpesu', 'muuttosiivous')
  ),
  constraint time_estimates_size_range_check check (size_max_m2 >= size_min_m2),
  constraint time_estimates_hours_range_check check (hours_max_1c >= hours_min_1c)
);

create index if not exists time_estimates_lookup_idx
  on public.time_estimates (service_type, size_min_m2, size_max_m2);

-- Reference data, read server-side by the extraction/estimation logic.
alter table public.time_estimates enable row level security;
