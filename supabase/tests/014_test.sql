-- Tests for 014 (per-user permissions). Dry-run only, after 012 and 014 (and 002 for the legacy tables);
-- everything is rolled back:
--   node --env-file=.env scripts/db.mjs supabase/migrations/012_store_map.sql supabase/migrations/014_user_permissions.sql supabase/migrations/002_lockdown_rls.sql supabase/tests/014_test.sql --dry-run

create temp table t_results (n serial, test text, expected text, got text, pass boolean) on commit drop;
grant all on t_results, t_results_n_seq to authenticated, anon;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin@lvajaltoun.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct@lvajaltoun.local',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000d', 't_deliv@lvajaltoun.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a1', 't_shelf@lvajaltoun.local', 'authenticated', 'authenticated');
insert into public.profiles (id, username, role, active) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin', 'admin', true),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct', 'accountant', true),
  ('00000000-0000-0000-0000-00000000000d', 't_deliv', 'delivery', true),
  ('00000000-0000-0000-0000-0000000000a1', 't_shelf', 'shelf', true);

create or replace function pg_temp.t(label text, who text, stmt text, expect text) returns void
language plpgsql as $$
declare got text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute stmt; got := 'ok';
  exception when others then got := 'blocked: ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  insert into t_results (test, expected, got, pass) values (label, expect, got, split_part(got, ':', 1) = expect);
end $$;
create or replace function pg_temp.expect(q text, want bigint) returns void
language plpgsql as $$ declare n bigint; begin execute q into n; if n is distinct from want then raise exception 'got %, expected %', n, want; end if; end $$;
create or replace function pg_temp.expect_text(q text, want text) returns void
language plpgsql as $$ declare v text; begin execute q into v; if v is distinct from want then raise exception 'got %, expected %', v, want; end if; end $$;
create or replace function pg_temp.check(label text, ok boolean) returns void
language sql as $$ insert into t_results (test, expected, got, pass) values (label, 'ok', case when ok then 'ok' else 'failed' end, ok) $$;

-- ---------- role templates = what each role could do before ----------
select pg_temp.t('accountant defaults', '00000000-0000-0000-0000-0000000000ac',
  $q$select pg_temp.expect_text('select array_to_string(public.my_permissions(), '','')',
     'sellouts.view,sellouts.archive,promotions.view,delivery.settle,cash.view,cash.enter,cash.lock,cash.cashiers,labels.print')$q$, 'ok');
select pg_temp.t('delivery defaults', '00000000-0000-0000-0000-00000000000d',
  $q$select pg_temp.expect_text('select array_to_string(public.my_permissions(), '','')', 'delivery.orders,delivery.settle,delivery.customers')$q$, 'ok');
select pg_temp.t('shelf defaults', '00000000-0000-0000-0000-0000000000a1',
  $q$select pg_temp.expect_text('select array_to_string(public.my_permissions(), '','')', 'labels.scan')$q$, 'ok');
select pg_temp.t('admin has all 31', '00000000-0000-0000-0000-00000000000a',
  $q$select pg_temp.expect('select cardinality(public.my_permissions())', 31)$q$, 'ok');

-- ---------- who may set permissions ----------
select pg_temp.t('accountant gives itself cash.unlock', '00000000-0000-0000-0000-0000000000ac',
  $q$insert into public.user_permissions (user_id, perm, allowed) values ('00000000-0000-0000-0000-0000000000ac', 'cash.unlock', true)$q$, 'blocked');
select pg_temp.t('unknown permission refused', '00000000-0000-0000-0000-00000000000a',
  $q$insert into public.user_permissions (user_id, perm, allowed) values ('00000000-0000-0000-0000-0000000000ac', 'nuclear.launch', true)$q$, 'blocked');
select pg_temp.t('admin adds + removes for the accountant', '00000000-0000-0000-0000-00000000000a',
  $q$insert into public.user_permissions (user_id, perm, allowed) values
     ('00000000-0000-0000-0000-0000000000ac', 'rentals.view', true),
     ('00000000-0000-0000-0000-0000000000ac', 'cash.unlock', true),
     ('00000000-0000-0000-0000-0000000000ac', 'cash.enter', false),
     ('00000000-0000-0000-0000-0000000000ac', 'promotions.audit', true),
     ('00000000-0000-0000-0000-0000000000ac', 'activity.view', true)$q$, 'ok');
select pg_temp.t('accountant reads own overrides only', '00000000-0000-0000-0000-0000000000ac',
  $q$select pg_temp.expect('select count(*) from public.user_permissions where user_id <> auth.uid()', 0)$q$, 'ok');
select pg_temp.t('delivery cannot read the accountant''s', '00000000-0000-0000-0000-00000000000d',
  $q$select pg_temp.expect('select count(*) from public.user_permissions', 0)$q$, 'ok');
select pg_temp.t('admin stays all-powerful (override ignored)', '00000000-0000-0000-0000-00000000000a',
  $q$insert into public.user_permissions (user_id, perm, allowed) values ('00000000-0000-0000-0000-00000000000a', 'cash.view', false);
     select pg_temp.expect('select count(*) filter (where public.has_perm(''cash.view'')) from (select 1) x', 1)$q$, 'ok');

-- ---------- cash: added unlock, removed enter ----------
insert into public.cashiers (id, name) values ('10000000-0000-0000-0000-0000000000c1', 'Test Cashier P');
insert into public.cash_months (month, locked) values ('2030-10', true);
select pg_temp.t('accountant (−cash.enter) enters a difference', '00000000-0000-0000-0000-0000000000ac',
  $q$insert into public.cash_differences (cashier_id, day, amount) values ('10000000-0000-0000-0000-0000000000c1', '2030-11-02', -3)$q$, 'blocked');
select pg_temp.t('…still sees the cash', '00000000-0000-0000-0000-0000000000ac',
  $q$select pg_temp.expect('select count(*) from public.cashiers where id = ''10000000-0000-0000-0000-0000000000c1''', 1)$q$, 'ok');
select pg_temp.t('accountant (+cash.unlock) unlocks', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.cash_months set locked = false where month = '2030-10'$q$, 'ok');
select pg_temp.check('…month unlocked', (select not locked from public.cash_months where month = '2030-10'));
select pg_temp.t('delivery reads cash', '00000000-0000-0000-0000-00000000000d',
  $q$select pg_temp.expect('select count(*) from public.cashiers', 0)$q$, 'ok');

-- ---------- rentals: view added, contracts not ----------
select pg_temp.t('accountant (+rentals.view) reads contracts', '00000000-0000-0000-0000-0000000000ac',
  $q$select 1 from public.rental_contracts limit 1$q$, 'ok');
select pg_temp.t('…cannot add a contract', '00000000-0000-0000-0000-0000000000ac',
  $q$insert into public.rental_contracts (id, supplier, term, start_date, end_date) values ('t_rc', 'X', 'yearly', '2030-01-01', '2030-12-31')$q$, 'blocked');
select pg_temp.t('…cannot edit the layout', '00000000-0000-0000-0000-0000000000ac',
  $q$insert into public.store_floors (id, name) values ('t_fl', 'X')$q$, 'blocked');
select pg_temp.t('delivery reads contracts: none', '00000000-0000-0000-0000-00000000000d',
  $q$select pg_temp.expect('select count(*) from public.rental_contracts', 0)$q$, 'ok');
select pg_temp.t('admin adds a contract', '00000000-0000-0000-0000-00000000000a',
  $q$insert into public.rental_contracts (id, supplier, term, start_date, end_date) values ('t_rc', 'X', 'yearly', '2030-01-01', '2030-12-31')$q$, 'ok');

-- ---------- labels: shelf worker given labels.print ----------
insert into public.user_permissions (user_id, perm, allowed) values ('00000000-0000-0000-0000-0000000000a1', 'labels.scan', false);
select pg_temp.t('shelf (−labels.scan) opens a list', '00000000-0000-0000-0000-0000000000a1',
  $q$insert into public.label_lists default values$q$, 'blocked');
delete from public.user_permissions where user_id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.t('shelf (back to role) opens a list', '00000000-0000-0000-0000-0000000000a1',
  $q$insert into public.label_lists (id) values ('40000000-0000-0000-0000-0000000000f1')$q$, 'ok');

-- ---------- activity log ----------
select pg_temp.t('accountant (+activity.view) reads the log', '00000000-0000-0000-0000-0000000000ac',
  $q$select 1 from public.activity_log limit 1$q$, 'ok');
select pg_temp.t('delivery reads the log: none', '00000000-0000-0000-0000-00000000000d',
  $q$select pg_temp.expect('select count(*) from public.activity_log', 0)$q$, 'ok');

-- ---------- promotions (002): audit only Type / Note ----------
insert into public.promotions (id, name) values ('t_pa', 'Test promo');
insert into public.promotion_rows (id, promotion_id, code, promo_price) values ('t_pa_r', 't_pa', '555', 4);
select pg_temp.t('accountant (+audit) sets Type', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.promotion_rows set price_type = 'cn', note = 'check' where id = 't_pa_r'$q$, 'ok');
select pg_temp.check('…type saved', (select price_type = 'cn' from public.promotion_rows where id = 't_pa_r'));
select pg_temp.t('…upsert of the same row (how the app saves)', '00000000-0000-0000-0000-0000000000ac',
  $q$insert into public.promotion_rows (id, promotion_id, code, promo_price, price_type) values ('t_pa_r', 't_pa', '555', 4, 'sellout')
     on conflict (id) do update set price_type = excluded.price_type$q$, 'ok');
select pg_temp.t('…cannot change the price', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.promotion_rows set promo_price = 0.5 where id = 't_pa_r'$q$, 'blocked');
select pg_temp.t('…cannot add a row', '00000000-0000-0000-0000-0000000000ac',
  $q$insert into public.promotion_rows (id, promotion_id, code) values ('t_pa_new', 't_pa', '1')$q$, 'blocked');
select pg_temp.t('…cannot archive (no promotions.archive)', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.promotions set archived = true where id = 't_pa'$q$, 'ok');
select pg_temp.check('…not archived', (select not archived from public.promotions where id = 't_pa'));

-- ---------- sell-outs (002): per column ----------
insert into public.sellouts (id, name, active, archived) values ('t_so_p', 'Test sell-out', false, false);
insert into public.user_permissions (user_id, perm, allowed) values ('00000000-0000-0000-0000-0000000000ac', 'sellouts.price', true);
select pg_temp.t('accountant (+price) sets prices', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.sellouts set price_column = 'Price' where id = 't_so_p'$q$, 'ok');
select pg_temp.t('…cannot rename', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.sellouts set name = 'x' where id = 't_so_p'$q$, 'blocked');
select pg_temp.t('…still archives', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.sellouts set archived = true where id = 't_so_p'$q$, 'ok');

-- ---------- delivery (014 trigger): delivery.manage added ----------
insert into public.dt_orders (id, order_date, c_name, amount) values ('t_old_o', public.beirut_today() - 3, 'Test', 10);
select pg_temp.t('delivery edits an old order', '00000000-0000-0000-0000-00000000000d',
  $q$update public.dt_orders set amount = 12 where id = 't_old_o'$q$, 'blocked');
insert into public.user_permissions (user_id, perm, allowed) values ('00000000-0000-0000-0000-00000000000d', 'delivery.manage', true);
select pg_temp.t('delivery (+manage) edits an old order', '00000000-0000-0000-0000-00000000000d',
  $q$update public.dt_orders set amount = 12 where id = 't_old_o'$q$, 'ok');
select pg_temp.t('accountant marks it paid', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.dt_orders set paid = true where id = 't_old_o'$q$, 'ok');
select pg_temp.t('accountant changes its amount', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.dt_orders set amount = 1 where id = 't_old_o'$q$, 'blocked');

-- ---------- a disabled user has nothing ----------
update public.profiles set active = false where id = '00000000-0000-0000-0000-0000000000ac';
select pg_temp.t('disabled accountant: no permissions', '00000000-0000-0000-0000-0000000000ac',
  $q$select pg_temp.expect('select cardinality(public.my_permissions())', 0)$q$, 'ok');

select json_agg(json_build_object('n', n, 'pass', pass, 'test', test, 'expected', expected, 'got', got) order by n) from t_results;
