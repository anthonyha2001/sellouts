-- 090 — Store profit, month by month (owner, 2026-10-12). Admin only.
--   store_months  : what the system gives for a month, computed by lv-dashboard (month_profit): sales, the cost of the goods sold
--                   (each item sold x its unit cost: that month's purchases / units, else its last 3 months of purchases; an item
--                   with no purchase in those months is not costed and its sales are counted apart), gross profit. Kept, made
--                   again on request (a month not over is made again each time it is opened).
--   store_expenses: the store's expenses of a month, typed by the admin (salaries, electricity, generator, rent…), in $ or LBP
--                   (LBP at the rate typed with it).
--   Apart, never guessed: the butchery (its cuts are never bought under their own codes; the carcasses are bought as "VIANDE /KG"
--   in the transitory items): its sales and the meat bought that month side by side; the invoice extras (MARCHANDISE AVEC TVA,
--   EXTRA ITEM, CHARGE WITHOUT VAT, whole invoices on one line) listed by supplier, not counted; the other sales without a cost.
-- Additive only: two new tables.
create table if not exists public.store_months (
  month date primary key,                 -- the 1st of the month
  sales numeric, cogs numeric, gross numeric,
  costed_sales numeric, uncosted_sales numeric, uncosted_items integer,
  purchases numeric,
  by_section jsonb,                       -- the detail: the butchery (sales, meat bought), the invoice extras
  computed_at timestamptz not null default now()
);
create table if not exists public.store_expenses (
  id uuid primary key default gen_random_uuid(),
  month date not null,
  category text not null,
  label text,
  amount numeric not null,
  currency text not null default 'USD' check (currency in ('USD', 'LBP')),
  rate numeric,                           -- LBP for 1 USD, for an amount in LBP
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists store_expenses_month on public.store_expenses (month);
alter table public.store_months enable row level security;
alter table public.store_expenses enable row level security;
drop policy if exists store_months_admin on public.store_months;
create policy store_months_admin on public.store_months for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.active));
drop policy if exists store_expenses_admin on public.store_expenses;
create policy store_expenses_admin on public.store_expenses for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.active))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.active));
