-- Migration: proposed-appointment columns on quotes (Phase 5).
--
-- After estimating hours/price, the pipeline computes a PROPOSED appointment
-- slot from Google Calendar availability + the booking rules. These are a
-- proposal requiring confirmation — not a booking. On approval, a tentative
-- calendar event is created and its id stored in calendar_event_id (so we don't
-- double-create on resend/retry). All times are Europe/Helsinki wall-clock.

alter table public.quotes
  add column if not exists proposed_date       date,
  add column if not exists proposed_start_time time,
  add column if not exists proposed_end_time   time,
  -- Set once the tentative hold event is created on approval.
  add column if not exists calendar_event_id   text;
