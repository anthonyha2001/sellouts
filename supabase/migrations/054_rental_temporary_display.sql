-- 054 — Temporary display on a rentable spot (owner, 2026-10-04): the spot is filled for now (our own goods,
-- or a supplier for a while) but stays available for rent — no amount, not counted as rented, no alerts.
-- Stored as a contract with term 'temporary' (amount 0). ADDITIVE (one more allowed term).
alter table public.rental_contracts drop constraint if exists rental_contracts_term_check;
alter table public.rental_contracts add constraint rental_contracts_term_check
  check (term in ('yearly', 'monthly', 'contract', 'temporary'));
