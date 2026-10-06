-- 068 — A supplier's contract terms on the vendor (owner, 2026-10-06).
--   Back margins (each: type, % or fixed amount, on invoice / on statement, how often), payment days, returns of
--   expired goods, minimum order, the contract's dates, notes. Shown in Pricing: the supplier's terms on its PUs,
--   the net-net cost (net minus the on-statement %), and a flag when an on-invoice % is missing from a PU line.
-- ADDITIVE (one column; the vendors policies already cover it).
alter table public.vendors add column if not exists contract jsonb not null default '{}';
