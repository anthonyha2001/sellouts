-- 072 — Low stock: a false flag set apart (owner, 2026-10-06). Almaza Light 60174: the system shows -26 although 72 were bought
--   on 11-09 and 21 sold since (the system was already at -65 before that PU: sold before being received). Such an item is not
--   "running low", its count in the system is wrong. doubtful = bought at the last PU - sold since is above the system's stock
--   and would cover the days of stock to keep; est_stock = bought - sold since (what should at least be there, if the stock
--   before that PU was not below 0). Not notified, not counted as low; listed apart, to count. Additive only.
alter table public.stock_alerts add column if not exists doubtful boolean not null default false;
alter table public.stock_alerts add column if not exists est_stock numeric;
