-- Migration: billing address collection (client feedback).
--
-- Invoicing requires a full postal billing address, which the inquiry rarely
-- includes up front. We extract whatever street-level detail the customer gave
-- (street, building number, apartment/door number) and, together with the
-- existing postal_code/city, treat that as the billing address. When it's
-- incomplete, needs_billing_address is true and the quote asks the customer to
-- provide it (so we can bill them).

alter table public.inquiries
  add column if not exists billing_street          text,
  add column if not exists billing_building_number text,
  add column if not exists billing_apartment       text,
  add column if not exists needs_billing_address   boolean not null default true;
