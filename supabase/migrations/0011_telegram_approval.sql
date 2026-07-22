-- Migration: Telegram staff approval flow (Phase 6).
--
-- Adds the state needed to drive quote approval/decline/edit from a Telegram
-- chat: the message id of the notification we posted (so we can reference it),
-- a decline reason, the 'declined' status, and a small table tracking when a
-- chat is expected to send a follow-up text (a custom-edit instruction or a
-- decline reason) — necessary because Telegram webhooks are stateless.

alter table public.quotes
  add column if not exists telegram_message_id bigint,
  add column if not exists decline_reason      text;

-- Allow the new 'declined' status alongside the existing workflow states.
alter table public.quotes
  drop constraint if exists quotes_status_check;
alter table public.quotes
  add constraint quotes_status_check
    check (status in ('draft', 'approved', 'rejected', 'declined'));

-- Pending follow-up text expected from a chat. kind distinguishes a custom-edit
-- instruction from a decline reason. One quote can have at most one pending row
-- at a time; a new Custom press replaces any prior pending edit for that quote.
create table if not exists public.telegram_pending_edits (
  id         uuid primary key default gen_random_uuid(),
  chat_id    bigint not null,
  quote_id   uuid   not null references public.quotes(id) on delete cascade,
  kind       text   not null default 'edit',
  created_at timestamptz not null default now(),

  constraint telegram_pending_edits_kind_check check (kind in ('edit', 'decline_reason'))
);

-- We look up the pending row by chat (the incoming message's chat) and by quote.
create index if not exists telegram_pending_edits_chat_idx
  on public.telegram_pending_edits (chat_id, created_at desc);
create unique index if not exists telegram_pending_edits_quote_uidx
  on public.telegram_pending_edits (quote_id);

alter table public.telegram_pending_edits enable row level security;
