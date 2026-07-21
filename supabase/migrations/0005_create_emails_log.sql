-- Migration: create emails_log table
-- Records every email send attempt (Phase 3). One row per attempt, whether it
-- succeeded or failed.

create extension if not exists "pgcrypto";

create table if not exists public.emails_log (
  id                uuid primary key default gen_random_uuid(),
  inquiry_id        uuid not null references public.inquiries(id) on delete cascade,
  quote_id          uuid references public.quotes(id) on delete set null,
  direction         text not null,
  email_type        text not null,
  to_address        text not null,
  subject           text not null,
  body              text not null,
  resend_message_id text,
  status            text not null default 'sent',
  created_at        timestamptz not null default now(),

  constraint emails_log_direction_check check (direction in ('outbound', 'inbound')),
  constraint emails_log_email_type_check check (
    email_type in ('offer', 'confirmation', 'reminder')
  ),
  constraint emails_log_status_check check (status in ('sent', 'failed'))
);

create index if not exists emails_log_inquiry_id_idx on public.emails_log (inquiry_id);
create index if not exists emails_log_quote_id_idx on public.emails_log (quote_id);
create index if not exists emails_log_created_at_idx on public.emails_log (created_at desc);

-- RLS enabled with no policies: service role (server-side) only.
alter table public.emails_log enable row level security;
