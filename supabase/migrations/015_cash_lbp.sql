-- 015 — Cash differences in LBP (owner, 2026-09-29: "the grid must be in LBP, convert everything").
-- Every amount goes back to LBP: rows imported from the old LBP sheets get their exact original LBP
-- amount (source_amount); anything typed in USD is multiplied by the rate (89,500 LBP per USD, the
-- rate used for the import). The warning levels are converted the same way ($10 → 895,000 LBP,
-- $20 → 1,790,000 LBP). New rows default to LBP.
-- The month lock is paused only for this conversion (August 2026 is locked), then switched back on.
-- Safe to run twice: only USD rows / a USD setting are converted.
-- DEPLOY the updated cashier-view function together with this (it now reads the currency from settings).

alter table public.cash_differences disable trigger cash_differences_lock_guard;

update public.cash_differences d
   set amount = case when d.source_currency = 'LBP' and d.source_amount is not null then round(d.source_amount)
                     else round(d.amount * 89500) end,
       currency = 'LBP'
 where d.currency = 'USD'
   and not exists (select 1 from public.cash_differences x
                   where x.cashier_id = d.cashier_id and x.day = d.day and x.currency = 'LBP');

alter table public.cash_differences enable trigger cash_differences_lock_guard;

update public.cash_settings
   set warning_threshold = round(warning_threshold * 89500),
       danger_threshold  = round(danger_threshold * 89500),
       currency = 'LBP'
 where currency = 'USD';

alter table public.cash_differences alter column currency set default 'LBP';
alter table public.cash_settings    alter column currency set default 'LBP';
