-- Tests for 002 (PLAN §5.5). Dry-run only, right after the migration; everything is rolled back:
--   node --env-file=.env scripts/db.mjs supabase/migrations/002_lockdown_rls.sql supabase/tests/002_test.sql --dry-run
-- Impersonates throw-away users per role (and anon) and checks what they can read and change.

create temp table t_results (n serial, test text, expected text, got text, pass boolean) on commit drop;
grant all on t_results, t_results_n_seq to authenticated, anon;

-- Row counts as the table owner (RLS does not apply), to compare against what each role sees.
create temp table t_totals (t text primary key, n bigint) on commit drop;
grant select on t_totals to authenticated, anon;
do $$
declare t text;
begin
  foreach t in array array['sellouts','credit_notes','catalog_items','promotions','promotion_rows',
    'vendors','vendor_orders','vendor_skips','vendor_rentals','dt_drivers','dt_customers','dt_orders','dt_settings']
  loop
    execute format('insert into t_totals values (%L, (select count(*) from public.%I))', t, t);
  end loop;
  insert into t_totals values ('sellouts_active', (select count(*) from public.sellouts where active));
end $$;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin@lvajaltoun.local',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000d', 't_deliv@lvajaltoun.local',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct@lvajaltoun.local',   'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000f0', 't_floor@lvajaltoun.local',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000dd', 't_off@lvajaltoun.local',    'authenticated', 'authenticated');
insert into public.profiles (id, username, role, active) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin', 'admin', true),
  ('00000000-0000-0000-0000-00000000000d', 't_deliv', 'delivery', true),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct',  'accountant', true),
  ('00000000-0000-0000-0000-0000000000f0', 't_floor', 'floor_manager', true),
  ('00000000-0000-0000-0000-0000000000dd', 't_off',   'admin', false);      -- disabled admin

-- Fixture orders, created as the owner.
insert into public.dt_orders (id, order_date, c_name, amount) values
  ('t_today', public.beirut_today(),     'Test today', 10),
  ('t_old',   public.beirut_today() - 3, 'Test old',   20);

-- t(label, who, statement, 'ok' | 'blocked'); who = user uuid, or 'anon'.
create or replace function pg_temp.t(label text, who text, stmt text, expect text) returns void
language plpgsql as $$
declare got text;
begin
  if who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin
    execute stmt;
    got := 'ok';
  exception when others then
    got := 'blocked: ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  insert into t_results (test, expected, got, pass) values (label, expect, got, split_part(got, ':', 1) = expect);
end $$;

-- sees(table, 'none' | 'all' | 'active'): raises unless the current role sees that many rows.
-- 'all' = at least every row that existed before the tests (tests only ever add rows).
create or replace function pg_temp.sees(tbl text, mode text) returns void
language plpgsql as $$
declare n bigint; total bigint;
begin
  execute format('select count(*) from public.%I', tbl) into n;
  total := (select t_totals.n from t_totals where t = case when mode = 'active' then 'sellouts_active'
                                                            when mode = 'current' then tbl || '_current' else tbl end);
  if (mode = 'none' and n <> 0) or (mode = 'all' and n < total) or (mode in ('active', 'current') and n <> total) then
    raise exception 'sees % of % rows (expected %)', n, total, mode;
  end if;
end $$;

create or replace function pg_temp.expect_zero(q text) returns void
language plpgsql as $$ declare n bigint; begin execute q into n; if n <> 0 then raise exception 'saw % rows', n; end if; end $$;

-- Row checks as the owner (e.g. "the forbidden delete did not happen").
create or replace function pg_temp.check_owner(label text, ok boolean) returns void
language sql as $$ insert into t_results (test, expected, got, pass) values (label, 'ok', case when ok then 'ok' else 'failed' end, ok) $$;

-- ============ Signed out (anon): no table access at all ============
select pg_temp.t('anon reads ' || tb, 'anon', format('select 1 from public.%I limit 1', tb), 'blocked')
from unnest(array['sellouts','credit_notes','catalog_items','app_settings','promotions','promotion_rows','vendors',
  'vendor_orders','vendor_skips','vendor_rentals','dt_drivers','dt_customers','dt_orders','dt_settings',
  'profiles','activity_log','dt_staff']) tb;
select pg_temp.t('anon inserts an order', 'anon', $q$insert into public.dt_orders (id, c_name) values ('t_anon','x')$q$, 'blocked');
select pg_temp.t('anon deletes customers', 'anon', $q$delete from public.dt_customers$q$, 'blocked');
select pg_temp.t('anon writes activity log', 'anon', $q$insert into public.activity_log (module, action) values ('x','y')$q$, 'blocked');

-- ============ Delivery ============
select pg_temp.t('delivery sees all orders',        '00000000-0000-0000-0000-00000000000d', $q$select pg_temp.sees('dt_orders','all')$q$, 'ok');
select pg_temp.t('delivery sees all customers',     '00000000-0000-0000-0000-00000000000d', $q$select pg_temp.sees('dt_customers','all')$q$, 'ok');
select pg_temp.t('delivery sees drivers',           '00000000-0000-0000-0000-00000000000d', $q$select pg_temp.sees('dt_drivers','all')$q$, 'ok');
select pg_temp.t('delivery reads ' || tb || ': none', '00000000-0000-0000-0000-00000000000d', format($q$select pg_temp.sees(%L,'none')$q$, tb), 'ok')
from unnest(array['promotions','promotion_rows','sellouts','vendors','vendor_orders','vendor_rentals','credit_notes','catalog_items']) tb;
select pg_temp.t('delivery adds an order today',    '00000000-0000-0000-0000-00000000000d', $q$insert into public.dt_orders (id, order_date, c_name, amount) values ('t_new', public.beirut_today(), 'x', 5)$q$, 'ok');
select pg_temp.t('delivery edits today''s order',   '00000000-0000-0000-0000-00000000000d', $q$update public.dt_orders set amount = 11 where id = 't_today'$q$, 'ok');
select pg_temp.t('delivery edits yesterday''s order','00000000-0000-0000-0000-00000000000d', $q$update public.dt_orders set amount = 21 where id = 't_old'$q$, 'blocked');
select pg_temp.t('delivery marks old order paid',   '00000000-0000-0000-0000-00000000000d', $q$update public.dt_orders set paid = true, paid_at = public.beirut_today() where id = 't_old'$q$, 'ok');
select pg_temp.t('delivery saves old order via upsert (paid only)', '00000000-0000-0000-0000-00000000000d',
  $q$insert into public.dt_orders (id, created, order_date, c_name, amount, paid) select id, created, order_date, c_name, amount, false from public.dt_orders where id = 't_old'
     on conflict (id) do update set created = excluded.created, order_date = excluded.order_date, c_name = excluded.c_name, amount = excluded.amount, paid = excluded.paid$q$, 'ok');
select pg_temp.t('delivery deletes an order (silently nothing)', '00000000-0000-0000-0000-00000000000d', $q$delete from public.dt_orders where id = 't_today'$q$, 'ok');
select pg_temp.check_owner('…and the order is still there', exists (select 1 from public.dt_orders where id = 't_today'));
select pg_temp.t('delivery adds a customer',        '00000000-0000-0000-0000-00000000000d', $q$insert into public.dt_customers (id, name) values ('t_cust', 'Test')$q$, 'ok');
select pg_temp.t('delivery adds a driver',          '00000000-0000-0000-0000-00000000000d', $q$insert into public.dt_drivers (id, name) values ('t_drv', 'x')$q$, 'blocked');
select pg_temp.t('delivery writes settings',        '00000000-0000-0000-0000-00000000000d', $q$insert into public.dt_settings (key, value) values ('t_x', '{}')$q$, 'blocked');

-- ============ Accountant ============
select pg_temp.t('accountant sees all sell-outs',   '00000000-0000-0000-0000-0000000000ac', $q$select pg_temp.sees('sellouts','all')$q$, 'ok');
select pg_temp.t('accountant sees all promotions',  '00000000-0000-0000-0000-0000000000ac', $q$select pg_temp.sees('promotions','all')$q$, 'ok');
select pg_temp.t('accountant sees all promo rows',  '00000000-0000-0000-0000-0000000000ac', $q$select pg_temp.sees('promotion_rows','all')$q$, 'ok');
select pg_temp.t('accountant sees all orders',      '00000000-0000-0000-0000-0000000000ac', $q$select pg_temp.sees('dt_orders','all')$q$, 'ok');
select pg_temp.t('accountant reads ' || tb || ': none', '00000000-0000-0000-0000-0000000000ac', format($q$select pg_temp.sees(%L,'none')$q$, tb), 'ok')
from unnest(array['credit_notes','vendors','vendor_orders','vendor_skips','vendor_rentals','dt_customers']) tb;
select pg_temp.t('accountant marks paid via upsert','00000000-0000-0000-0000-0000000000ac',
  $q$insert into public.dt_orders (id, created, order_date, c_name, amount, paid, paid_at) select id, created, order_date, c_name, amount, true, public.beirut_today() from public.dt_orders where id = 't_old'
     on conflict (id) do update set paid = excluded.paid, paid_at = excluded.paid_at$q$, 'ok');
select pg_temp.t('accountant creates an order',     '00000000-0000-0000-0000-0000000000ac', $q$insert into public.dt_orders (id, order_date, c_name) values ('t_acc', public.beirut_today(), 'x')$q$, 'blocked');
select pg_temp.t('accountant edits an amount',      '00000000-0000-0000-0000-0000000000ac', $q$update public.dt_orders set amount = 99 where id = 't_today'$q$, 'blocked');
select pg_temp.t('accountant adds a sell-out',      '00000000-0000-0000-0000-0000000000ac', $q$insert into public.sellouts (id, name) values ('t_so', 'x')$q$, 'ok');
select pg_temp.t('accountant adds a credit note',   '00000000-0000-0000-0000-0000000000ac', $q$insert into public.credit_notes (id, number) values ('t_cn', 'x')$q$, 'blocked');

-- ============ Floor manager ============
select pg_temp.t('floor sees only active sell-outs','00000000-0000-0000-0000-0000000000f0', $q$select pg_temp.sees('sellouts','active')$q$, 'ok');
-- Promotions: one running today and one that has ended (fixtures), then counts of what is current.
insert into public.promotions (id, name, from_date, to_date, archived) values
  ('t_promo_now', 'Test promo now', public.beirut_today() - 1, public.beirut_today() + 1, false),
  ('t_promo_old', 'Test promo old', public.beirut_today() - 20, public.beirut_today() - 10, false);
insert into public.promotion_rows (id, promotion_id, code, promo_price) values
  ('t_pr_now', 't_promo_now', '111', 1.5), ('t_pr_old', 't_promo_old', '222', 2.5);
insert into t_totals values
  ('promotions_current', (select count(*) from public.promotions where not archived and from_date <= public.beirut_today() and public.beirut_today() <= to_date)),
  ('promotion_rows_current', (select count(*) from public.promotion_rows r join public.promotions p on p.id = r.promotion_id
                              where not p.archived and p.from_date <= public.beirut_today() and public.beirut_today() <= p.to_date));
select pg_temp.t('floor sees only current promotions', '00000000-0000-0000-0000-0000000000f0', $q$select pg_temp.sees('promotions','current')$q$, 'ok');
select pg_temp.t('floor sees only their rows',         '00000000-0000-0000-0000-0000000000f0', $q$select pg_temp.sees('promotion_rows','current')$q$, 'ok');
select pg_temp.t('floor cannot see the ended promo',   '00000000-0000-0000-0000-0000000000f0', $q$select pg_temp.expect_zero($x$select count(*) from public.promotion_rows where id = 't_pr_old'$x$)$q$, 'ok');
select pg_temp.t('floor edits a promotion row (silently nothing)', '00000000-0000-0000-0000-0000000000f0', $q$update public.promotion_rows set promo_price = 0 where id = 't_pr_now'$q$, 'ok');
select pg_temp.check_owner('…row unchanged', (select promo_price = 1.5 from public.promotion_rows where id = 't_pr_now'));
select pg_temp.t('floor reads ' || tb || ': none',  '00000000-0000-0000-0000-0000000000f0', format($q$select pg_temp.sees(%L,'none')$q$, tb), 'ok')
from unnest(array['dt_orders','dt_customers','vendors','credit_notes','catalog_items']) tb;
select pg_temp.t('floor edits a sell-out',          '00000000-0000-0000-0000-0000000000f0', $q$insert into public.sellouts (id, name) values ('t_so2', 'x')$q$, 'blocked');

-- ============ Disabled account (even an admin) ============
select pg_temp.t('disabled admin reads ' || tb || ': none', '00000000-0000-0000-0000-0000000000dd', format($q$select pg_temp.sees(%L,'none')$q$, tb), 'ok')
from unnest(array['sellouts','promotions','dt_orders','vendors','credit_notes']) tb;

-- ============ Admin ============
select pg_temp.t('admin reads ' || tb || ': all', '00000000-0000-0000-0000-00000000000a', format($q$select pg_temp.sees(%L,'all')$q$, tb), 'ok')
from unnest(array['sellouts','credit_notes','catalog_items','promotions','promotion_rows','vendors','vendor_orders',
  'vendor_skips','vendor_rentals','dt_drivers','dt_customers','dt_orders','dt_settings']) tb;
select pg_temp.t('admin edits an old order',        '00000000-0000-0000-0000-00000000000a', $q$update public.dt_orders set amount = 25 where id = 't_old'$q$, 'ok');
select pg_temp.t('admin deletes an order',          '00000000-0000-0000-0000-00000000000a', $q$delete from public.dt_orders where id = 't_new'$q$, 'ok');
select pg_temp.check_owner('…and it is gone', not exists (select 1 from public.dt_orders where id = 't_new'));
select pg_temp.t('admin adds a driver',             '00000000-0000-0000-0000-00000000000a', $q$insert into public.dt_drivers (id, name) values ('t_drv2', 'x')$q$, 'ok');
select pg_temp.t('admin reads the activity log',    '00000000-0000-0000-0000-00000000000a', $q$select count(*) from public.activity_log$q$, 'ok');
select pg_temp.t('admin cannot truncate',           '00000000-0000-0000-0000-00000000000a', $q$truncate public.dt_orders$q$, 'blocked');

select json_agg(json_build_object('n', n, 'pass', pass, 'test', test, 'expected', expected, 'got', got) order by n) from t_results;
