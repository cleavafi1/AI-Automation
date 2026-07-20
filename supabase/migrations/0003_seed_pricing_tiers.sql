-- Migration: seed pricing_tiers with real Cleava pricing data.
-- Idempotent: clears existing rows first so re-running gives a clean seed.

delete from public.pricing_tiers;

insert into public.pricing_tiers (service_type, tier_label, rate_type, base_rate_eur, notes) values
  ('kotisiivous',     'viikoittain',        'hourly',     39,   'min. 2h order'),
  ('kotisiivous',     'joka_toinen_viikko', 'hourly',     45,   'min. 2h order'),
  ('kotisiivous',     'kuukausittain',      'hourly',     49,   'min. 2h order'),
  ('ikkunanpesu',     null,                 'hourly',     39,   null),
  ('suursiivous',     null,                 'hourly',     40,   null),
  ('muuttosiivous',   null,                 'hourly',     42,   null),
  ('toimistosiivous', 'Perussiivous',       'quote_only', null, '2–10h/week'),
  ('toimistosiivous', 'Jatkuva ylläpito',   'quote_only', null, '11–20h/week'),
  ('toimistosiivous', 'Premium-hoito',      'quote_only', null, '21+h/week'),
  ('porrassiivous',   null,                 'quote_only', null, null),
  ('erikoissiivous',  null,                 'quote_only', null, 'sauna/parveke/erikoiskohteet');
