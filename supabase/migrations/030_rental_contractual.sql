-- 030 — Rent billing can be "Contractual": one amount for the whole contract period, besides yearly
-- and monthly (owner, 2026-10-01). Widens the check on rental_contracts.term; existing rows stay valid.
-- ADDITIVE (the allowed values only grow).

alter table public.rental_contracts drop constraint if exists rental_contracts_term_check;
alter table public.rental_contracts add constraint rental_contracts_term_check
  check (term in ('yearly', 'monthly', 'contract'));
