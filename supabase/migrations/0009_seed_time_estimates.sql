-- Migration: seed time_estimates with the estimation guide's size-bracket
-- single-cleaner (1c) hour ranges. Idempotent: clears existing rows first.
--
-- Brackets share endpoints (…20–30, 30–40…) and are matched HALF-OPEN in code
-- ([size_min, size_max): see lib/extraction.ts), so a boundary value lands in
-- the upper bracket. Always assumes 1 cleaner — there is no cleaner-count model.
--
-- Only kotisiivous, ikkunanpesu and muuttosiivous are in the guide. suursiivous
-- keeps its 40 €/h rate but has no brackets → the code falls back to size-bucket
-- default hours for it.

delete from public.time_estimates;

insert into public.time_estimates
  (service_type, size_min_m2, size_max_m2, hours_min_1c, hours_max_1c) values
  -- kotisiivous
  ('kotisiivous',    20,  30,   3,  4),
  ('kotisiivous',    30,  40,   4,  6),
  ('kotisiivous',    40,  50,   5,  7),
  ('kotisiivous',    50,  60,   6,  8),
  ('kotisiivous',    60,  70,   7,  9),
  ('kotisiivous',    70,  80,   8, 10),
  ('kotisiivous',    80,  90,   9, 11),
  ('kotisiivous',    90, 100,  10, 12),
  ('kotisiivous',   100, 150,  13, 16),
  ('kotisiivous',   150, 200,  17, 21),
  ('kotisiivous',   200, 250,  21, 26),
  ('kotisiivous',   250, 300,  26, 31),
  -- ikkunanpesu
  ('ikkunanpesu',    20,  30,   2,  3),
  ('ikkunanpesu',    30,  40,   3,  4),
  ('ikkunanpesu',    40,  50,   3,  5),
  ('ikkunanpesu',    50,  60,   4,  5),
  ('ikkunanpesu',    60,  70,   4,  6),
  ('ikkunanpesu',    70,  80,   5,  6),
  ('ikkunanpesu',    80,  90,   5,  7),
  ('ikkunanpesu',    90, 100,   6,  7),
  ('ikkunanpesu',   100, 150,   7,  9),
  ('ikkunanpesu',   150, 200,   9, 11),
  ('ikkunanpesu',   200, 250,  11, 13),
  ('ikkunanpesu',   250, 300,  13, 15),
  -- muuttosiivous
  ('muuttosiivous',  20,  30,   4,  5),
  ('muuttosiivous',  30,  40,   4,  6),
  ('muuttosiivous',  40,  50,   5,  7),
  ('muuttosiivous',  50,  60,   6,  8),
  ('muuttosiivous',  60,  70,   7,  9),
  ('muuttosiivous',  70,  80,   8, 11),
  ('muuttosiivous',  80,  90,   9, 12),
  ('muuttosiivous',  90, 100,  10, 13),
  ('muuttosiivous', 100, 150,  13, 17),
  ('muuttosiivous', 150, 200,  17, 21),
  ('muuttosiivous', 200, 250,  21, 26),
  ('muuttosiivous', 250, 300,  26, 31);
