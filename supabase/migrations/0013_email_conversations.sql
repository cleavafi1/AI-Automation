-- Migration: Phase 7 — conversational email replies.
--
-- Adds the full per-quote conversation history (both directions) plus the state
-- needed to route each inbound customer reply through the SAME Telegram approval
-- gate as the original offer. Also allows a 'confirmed' quote status (set only
-- when staff approve an acceptance reply and the tentative hold is confirmed).

-- 1. Allow 'confirmed' alongside the existing workflow states.
alter table public.quotes
  drop constraint if exists quotes_status_check;
alter table public.quotes
  add constraint quotes_status_check
    check (status in ('draft', 'approved', 'rejected', 'declined', 'confirmed'));

-- 2. Conversation history. One row per message in either direction. Outbound
-- rows are drafted responses awaiting Telegram approval (status pending_review)
-- until an explicit Approve tap sends them. Inbound rows are recorded facts.
create table if not exists public.email_conversations (
  id                  uuid primary key default gen_random_uuid(),
  quote_id            uuid not null references public.quotes(id) on delete cascade,
  direction           text not null,
  from_address        text,
  subject             text,
  body_text           text,
  resend_email_id     text,
  classified_intent   text,
  telegram_message_id bigint,
  status              text not null default 'pending_review',
  -- New slot carried by a reschedule draft, applied to the quote only on Approve.
  proposed_date       date,
  proposed_start_time time,
  proposed_end_time   time,
  created_at          timestamptz not null default now(),

  constraint email_conversations_direction_check
    check (direction in ('inbound', 'outbound')),
  constraint email_conversations_status_check
    check (status in ('pending_review', 'approved', 'declined')),
  constraint email_conversations_intent_check check (
    classified_intent is null or classified_intent in (
      'acceptance', 'reschedule_request', 'question', 'decline', 'unclear'
    )
  )
);

create index if not exists email_conversations_quote_id_idx
  on public.email_conversations (quote_id, created_at);
create index if not exists email_conversations_created_at_idx
  on public.email_conversations (created_at desc);

-- RLS enabled with no policies: service role (server-side) only.
alter table public.email_conversations enable row level security;

-- 3. Extend the existing pending-follow-up table so the SAME chat-keyed edit /
-- decline-reason loop works for conversation replies, not just quotes.
alter table public.telegram_pending_edits
  add column if not exists conversation_id uuid
    references public.email_conversations(id) on delete cascade;

-- A pending row now refers to EITHER a quote (original offer) or a conversation
-- reply, so quote_id becomes nullable.
alter table public.telegram_pending_edits
  alter column quote_id drop not null;

-- Allow the two new reply kinds.
alter table public.telegram_pending_edits
  drop constraint if exists telegram_pending_edits_kind_check;
alter table public.telegram_pending_edits
  add constraint telegram_pending_edits_kind_check
    check (kind in ('edit', 'decline_reason', 'reply_edit', 'reply_decline_reason'));

-- The old one-pending-per-quote unique index is replaced by upsert-by-key logic
-- in code (delete-then-insert), which also covers conversation rows.
drop index if exists public.telegram_pending_edits_quote_uidx;

create index if not exists telegram_pending_edits_conversation_idx
  on public.telegram_pending_edits (conversation_id);
