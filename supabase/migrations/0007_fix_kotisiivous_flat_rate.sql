-- Migration: correct kotisiivous pricing to a single flat rate (Phase 4).
--
-- The original seed modelled kotisiivous as frequency-tiered (39 weekly /
-- 45 bi-weekly / 49 monthly). The real, confirmed price is a flat 39 €/h
-- regardless of frequency. Replace the three frequency rows with one flat
-- hourly row. The other services were already confirmed consistent and are
-- left untouched:
--   ikkunanpesu   39 €/h
--   suursiivous   40 €/h
--   muuttosiivous 42 €/h

delete from public.pricing_tiers where service_type = 'kotisiivous';

insert into public.pricing_tiers (service_type, tier_label, rate_type, base_rate_eur, notes) values
  ('kotisiivous', null, 'hourly', 39, 'Flat 39 €/h regardless of frequency. min. 2h order');
