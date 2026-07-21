-- Migration: create quotes table
-- Stores AI-drafted quote/offer text per inquiry (Phase 2).
-- Nothing here is sent to a customer — these are internal drafts for review.

create extension if not exists "pgcrypto";

create table if not exists public.quotes (
  id                  uuid primary key default gen_random_uuid(),
  inquiry_id          uuid not null references public.inquiries(id) on delete cascade,
  drafted_text        text not null,
  estimated_price_eur numeric,
  is_flagged          boolean not null default false,
  flag_reason         text,
  status              text not null default 'draft',
  created_at          timestamptz not null default now(),

  constraint quotes_status_check check (status in ('draft', 'approved', 'rejected'))
);

create index if not exists quotes_inquiry_id_idx on public.quotes (inquiry_id);
create index if not exists quotes_created_at_idx on public.quotes (created_at desc);
create index if not exists quotes_is_flagged_idx on public.quotes (is_flagged);

-- RLS enabled with no policies: only the service role (server-side) can access.
alter table public.quotes enable row level security;
