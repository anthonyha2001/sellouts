-- Tests for 005. Dry-run only, right after the migration; everything is rolled back:
--   node --env-file=.env scripts/db.mjs supabase/migrations/005_cash_differences.sql supabase/tests/005_test.sql --dry-run

create temp table t_results (n serial, test text, expected text, got text, pass boolean) on commit drop;
grant all on t_results, t_results_n_seq to authenticated, anon, service_role;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin@lvajaltoun.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct@lvajaltoun.local',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000d', 't_deliv@lvajaltoun.local', 'authenticated', 'authenticated');
insert into public.profiles (id, username, role, active) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin', 'admin', true),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct',  'accountant', true),
  ('00000000-0000-0000-0000-00000000000d', 't_deliv', 'delivery', true);

insert into public.cashiers (id, name, sort_order) values
  ('10000000-0000-0000-0000-000000000001', 'Test Cashier A', 1),
  ('10000000-0000-0000-0000-000000000002', 'Test Cashier B', 2);

-- who: user uuid, 'anon' or 'service'
create or replace function pg_temp.t(label text, who text, stmt text, expect text) returns void
language plpgsql as $$
declare got text;
begin
  if who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true); execute 'set local role anon';
  elsif who = 'service' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true); execute 'set local role service_role';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin execute stmt; got := 'ok';
  exception when others then got := 'blocked: ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  insert into t_results (test, expected, got, pass) values (label, expect, got, split_part(got, ':', 1) = expect);
end $$;
create or replace function pg_temp.check(label text, ok boolean) returns void
language sql as $$ insert into t_results (test, expected, got, pass) values (label, 'ok', case when ok then 'ok' else 'failed' end, ok) $$;
-- expect_count(sql, n): raises unless the query returns n
create or replace function pg_temp.expect(q text, want bigint) returns void
language plpgsql as $$ declare n bigint; begin execute q into n; if n is distinct from want then raise exception 'got %, expected %', n, want; end if; end $$;

-- ---------- outsiders ----------
select pg_temp.t('anon reads cashiers',           'anon', $q$select 1 from public.cashiers$q$, 'blocked');
select pg_temp.t('anon reads differences',        'anon', $q$select 1 from public.cash_differences$q$, 'blocked');
select pg_temp.t('anon verifies a PIN directly',  'anon', $q$select * from public.cashier_verify_pin('10000000-0000-0000-0000-000000000001','1234')$q$, 'blocked');
select pg_temp.t('delivery sees no cashiers',     '00000000-0000-0000-0000-00000000000d', $q$select pg_temp.expect('select count(*) from public.cashiers', 0)$q$, 'ok');
select pg_temp.t('delivery adds a difference',    '00000000-0000-0000-0000-00000000000d', $q$insert into public.cash_differences (cashier_id, day, amount) values ('10000000-0000-0000-0000-000000000001', '2030-09-01', -5)$q$, 'blocked');
select pg_temp.t('delivery sets a PIN',           '00000000-0000-0000-0000-00000000000d', $q$select public.set_cashier_pin('10000000-0000-0000-0000-000000000001','1234')$q$, 'blocked');

-- ---------- accountant ----------
select pg_temp.t('accountant sees cashiers',      '00000000-0000-0000-0000-0000000000ac', $q$select pg_temp.expect('select count(*) from public.cashiers where name like ''Test Cashier%''', 2)$q$, 'ok');
select pg_temp.t('accountant reads pin_hash',     '00000000-0000-0000-0000-0000000000ac', $q$select pin_hash from public.cashiers$q$, 'blocked');
select pg_temp.t('accountant adds a cashier',     '00000000-0000-0000-0000-0000000000ac', $q$insert into public.cashiers (name, sort_order) values ('Test Cashier C', 3)$q$, 'ok');
select pg_temp.t('duplicate name (any case)',     '00000000-0000-0000-0000-0000000000ac', $q$insert into public.cashiers (name) values (' test cashier a ')$q$, 'blocked');
select pg_temp.t('accountant sets a PIN',         '00000000-0000-0000-0000-0000000000ac', $q$select public.set_cashier_pin('10000000-0000-0000-0000-000000000001','4821')$q$, 'ok');
select pg_temp.t('PIN must be 4 digits',          '00000000-0000-0000-0000-0000000000ac', $q$select public.set_cashier_pin('10000000-0000-0000-0000-000000000001','48a1')$q$, 'blocked');
select pg_temp.t('has_pin shows, hash stored',    '00000000-0000-0000-0000-0000000000ac', $q$select pg_temp.expect('select count(*) from public.cashiers where id = ''10000000-0000-0000-0000-000000000001'' and has_pin', 1)$q$, 'ok');
select pg_temp.check('hash is bcrypt, not the PIN', (select pin_hash like '$2a$%' and pin_hash <> '4821' from public.cashiers where id = '10000000-0000-0000-0000-000000000001'));
select pg_temp.t('accountant verifies a PIN',     '00000000-0000-0000-0000-0000000000ac', $q$select * from public.cashier_verify_pin('10000000-0000-0000-0000-000000000001','4821')$q$, 'blocked');
select pg_temp.t('accountant enters a shortage',  '00000000-0000-0000-0000-0000000000ac', $q$insert into public.cash_differences (cashier_id, day, amount) values ('10000000-0000-0000-0000-000000000001', '2030-08-03', -12.5)$q$, 'ok');
select pg_temp.check('…stamped with the accountant', (select created_by = '00000000-0000-0000-0000-0000000000ac' and currency = 'USD' from public.cash_differences where day = '2030-08-03'));
select pg_temp.t('same cashier+day twice',        '00000000-0000-0000-0000-0000000000ac', $q$insert into public.cash_differences (cashier_id, day, amount) values ('10000000-0000-0000-0000-000000000001', '2030-08-03', 1)$q$, 'blocked');
select pg_temp.t('accountant locks August',       '00000000-0000-0000-0000-0000000000ac', $q$insert into public.cash_months (month, locked) values ('2030-08', true)$q$, 'ok');
select pg_temp.check('…lock stamped',              (select locked_by = '00000000-0000-0000-0000-0000000000ac' and locked_at is not null from public.cash_months where month = '2030-08'));
select pg_temp.t('write into locked month',       '00000000-0000-0000-0000-0000000000ac', $q$insert into public.cash_differences (cashier_id, day, amount) values ('10000000-0000-0000-0000-000000000002', '2030-08-04', 3)$q$, 'blocked');
select pg_temp.t('edit in locked month',          '00000000-0000-0000-0000-0000000000ac', $q$update public.cash_differences set amount = 0 where day = '2030-08-03'$q$, 'blocked');
select pg_temp.t('move a day into locked month',  '00000000-0000-0000-0000-0000000000ac', $q$insert into public.cash_differences (cashier_id, day, amount) values ('10000000-0000-0000-0000-000000000002', '2030-09-04', 3); update public.cash_differences set day = '2030-08-04' where day = '2030-09-04'$q$, 'blocked');
select pg_temp.t('delete in locked month',        '00000000-0000-0000-0000-0000000000ac', $q$delete from public.cash_differences where day = '2030-08-03'$q$, 'blocked');
select pg_temp.t('accountant unlocks August',     '00000000-0000-0000-0000-0000000000ac', $q$update public.cash_months set locked = false where month = '2030-08'$q$, 'blocked');
select pg_temp.t('admin unlocks August',          '00000000-0000-0000-0000-00000000000a', $q$update public.cash_months set locked = false where month = '2030-08'$q$, 'ok');
select pg_temp.t('…then the edit works',          '00000000-0000-0000-0000-0000000000ac', $q$update public.cash_differences set amount = -10 where day = '2030-08-03'$q$, 'ok');
select pg_temp.t('red below orange refused',      '00000000-0000-0000-0000-0000000000ac', $q$update public.cash_settings set danger_threshold = 5 where id = 'app'$q$, 'blocked');
select pg_temp.t('accountant changes thresholds', '00000000-0000-0000-0000-0000000000ac', $q$update public.cash_settings set warning_threshold = 8, danger_threshold = 25 where id = 'app'$q$, 'ok');
select pg_temp.t('delete a cashier',              '00000000-0000-0000-0000-00000000000a', $q$delete from public.cashiers where id = '10000000-0000-0000-0000-000000000002'$q$, 'blocked');

-- ---------- the edge function's PIN check (service role) ----------
select pg_temp.t('right PIN',  'service', $q$select pg_temp.expect($x$select count(*) from public.cashier_verify_pin('10000000-0000-0000-0000-000000000001','4821') where status = 'ok'$x$, 1)$q$, 'ok');
select pg_temp.t('wrong PIN 1 (4 left)', 'service', $q$select pg_temp.expect($x$select count(*) from public.cashier_verify_pin('10000000-0000-0000-0000-000000000001','0000') where status = 'wrong' and attempts_left = 4$x$, 1)$q$, 'ok');
select pg_temp.t('wrong PINs 2-4', 'service', $q$select public.cashier_verify_pin('10000000-0000-0000-0000-000000000001','0000') from generate_series(1,3)$q$, 'ok');
select pg_temp.t('wrong PIN 5 locks', 'service', $q$select pg_temp.expect($x$select count(*) from public.cashier_verify_pin('10000000-0000-0000-0000-000000000001','0000') where status = 'locked' and locked_until > now() + interval '14 minutes'$x$, 1)$q$, 'ok');
select pg_temp.t('right PIN while locked', 'service', $q$select pg_temp.expect($x$select count(*) from public.cashier_verify_pin('10000000-0000-0000-0000-000000000001','4821') where status = 'locked'$x$, 1)$q$, 'ok');
select pg_temp.t('cashier without PIN', 'service', $q$select pg_temp.expect($x$select count(*) from public.cashier_verify_pin('10000000-0000-0000-0000-000000000002','1234') where status = 'no_pin'$x$, 1)$q$, 'ok');
select pg_temp.t('resetting the PIN unlocks', '00000000-0000-0000-0000-0000000000ac', $q$select public.set_cashier_pin('10000000-0000-0000-0000-000000000001','5555')$q$, 'ok');
select pg_temp.t('new PIN works', 'service', $q$select pg_temp.expect($x$select count(*) from public.cashier_verify_pin('10000000-0000-0000-0000-000000000001','5555') where status = 'ok'$x$, 1)$q$, 'ok');

select json_agg(json_build_object('n', n, 'pass', pass, 'test', test, 'expected', expected, 'got', got) order by n) from t_results;
