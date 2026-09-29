-- Tests for 001. Run ONLY in dry-run mode, right after the migration, so everything is rolled back:
--   node --env-file=.env scripts/db.mjs supabase/migrations/001_profiles_roles_activity.sql supabase/tests/001_test.sql --dry-run
-- Creates throw-away users per role, impersonates them via request.jwt.claims, records pass/fail.

create temp table t_results (n serial, test text, expected text, got text, pass boolean) on commit drop;
grant all on t_results, t_results_n_seq to authenticated;

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
  ('00000000-0000-0000-0000-0000000000dd', 't_off',   'delivery', false);   -- disabled user

-- Fixture orders (inserted as postgres = no auth.uid(), i.e. how the current apps write).
insert into public.dt_orders (id, order_date, c_name, amount) values
  ('t_today', public.beirut_today(),     'Test today', 10),
  ('t_old',   public.beirut_today() - 3, 'Test old',   20);

-- Runs one statement as a user; records whether it succeeded against what was expected.
create or replace function pg_temp.t(label text, uid text, stmt text, expect text) returns void
language plpgsql as $$
declare got text;
begin
  perform set_config('request.jwt.claims', coalesce(json_build_object('sub', uid, 'role', 'authenticated')::text, ''), true);
  if uid is not null then execute 'set local role authenticated'; end if;
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

-- Role resolution
select pg_temp.t('app_role admin',     '00000000-0000-0000-0000-00000000000a', $q$do $d$ begin if public.app_role() is distinct from 'admin' then raise exception 'got %', public.app_role(); end if; end $d$$q$, 'ok');
select pg_temp.t('app_role disabled = null', '00000000-0000-0000-0000-0000000000dd', $q$do $d$ begin if public.app_role() is not null then raise exception 'got %', public.app_role(); end if; end $d$$q$, 'ok');

-- Delivery
select pg_temp.t('delivery edits today order',      '00000000-0000-0000-0000-00000000000d', $q$update public.dt_orders set amount = 11 where id = 't_today'$q$, 'ok');
select pg_temp.t('delivery edits old order',        '00000000-0000-0000-0000-00000000000d', $q$update public.dt_orders set amount = 21 where id = 't_old'$q$, 'blocked');
select pg_temp.t('delivery marks old order paid',   '00000000-0000-0000-0000-00000000000d', $q$update public.dt_orders set paid = true, paid_at = public.beirut_today() where id = 't_old'$q$, 'ok');
select pg_temp.t('delivery moves today order back', '00000000-0000-0000-0000-00000000000d', $q$update public.dt_orders set order_date = public.beirut_today() - 1 where id = 't_today'$q$, 'blocked');
select pg_temp.t('delivery creates today order',    '00000000-0000-0000-0000-00000000000d', $q$insert into public.dt_orders (id, order_date, c_name, amount) values ('t_new', public.beirut_today(), 'x', 5)$q$, 'ok');
select pg_temp.t('delivery creates backdated order','00000000-0000-0000-0000-00000000000d', $q$insert into public.dt_orders (id, order_date, c_name, amount) values ('t_back', public.beirut_today() - 1, 'x', 5)$q$, 'blocked');
select pg_temp.t('delivery upsert (sync) unchanged old row + paid', '00000000-0000-0000-0000-00000000000d',
  $q$insert into public.dt_orders (id, created, order_date, c_name, amount, paid) select id, created, order_date, c_name, amount, false from public.dt_orders where id = 't_old'
     on conflict (id) do update set created = excluded.created, order_date = excluded.order_date, c_name = excluded.c_name, amount = excluded.amount, paid = excluded.paid$q$, 'ok');
select pg_temp.t('disabled delivery user edits today order', '00000000-0000-0000-0000-0000000000dd', $q$update public.dt_orders set amount = 12 where id = 't_today'$q$, 'blocked');

-- Accountant
select pg_temp.t('accountant marks paid',           '00000000-0000-0000-0000-0000000000ac', $q$update public.dt_orders set paid = false, paid_at = null where id = 't_old'$q$, 'ok');
select pg_temp.t('accountant edits amount',         '00000000-0000-0000-0000-0000000000ac', $q$update public.dt_orders set amount = 99 where id = 't_today'$q$, 'blocked');
select pg_temp.t('accountant creates order',        '00000000-0000-0000-0000-0000000000ac', $q$insert into public.dt_orders (id, order_date, c_name) values ('t_acc', public.beirut_today(), 'x')$q$, 'blocked');

-- Floor manager
select pg_temp.t('floor manager marks paid',        '00000000-0000-0000-0000-0000000000f0', $q$update public.dt_orders set paid = true where id = 't_old'$q$, 'blocked');

-- Admin
select pg_temp.t('admin edits old order',           '00000000-0000-0000-0000-00000000000a', $q$update public.dt_orders set amount = 25, order_date = public.beirut_today() - 4 where id = 't_old'$q$, 'ok');

-- Current anonymous apps must keep working until 002
select pg_temp.t('anon edits old order (pre-002)',  null, $q$update public.dt_orders set amount = 30 where id = 't_old'$q$, 'ok');

-- Audit stamps
select pg_temp.t('created_by stamped on insert', null, $q$do $d$ begin if (select created_by from public.dt_orders where id = 't_new') is distinct from '00000000-0000-0000-0000-00000000000d' then raise exception 'wrong'; end if; end $d$$q$, 'ok');
select pg_temp.t('updated_by = admin (anon update leaves it)', null, $q$do $d$ begin if (select updated_by from public.dt_orders where id = 't_old') is distinct from '00000000-0000-0000-0000-00000000000a' then raise exception 'got %', (select updated_by from public.dt_orders where id = 't_old'); end if; end $d$$q$, 'ok');

-- Activity log
select pg_temp.t('delivery writes log (forged user_id ignored)', '00000000-0000-0000-0000-00000000000d',
  $q$insert into public.activity_log (user_id, module, action, summary) values ('00000000-0000-0000-0000-00000000000a', 'delivery', 'test', 'forged')$q$, 'ok');
select pg_temp.t('log row stamped with real user', null, $q$do $d$ begin if (select user_id::text || '/' || username || '/' || role from public.activity_log where action = 'test') <> '00000000-0000-0000-0000-00000000000d/t_deliv/delivery' then raise exception 'got %', (select user_id::text || '/' || username || '/' || role from public.activity_log where action = 'test'); end if; end $d$$q$, 'ok');
select pg_temp.t('delivery cannot read log', '00000000-0000-0000-0000-00000000000d', $q$do $d$ begin if (select count(*) from public.activity_log) <> 0 then raise exception 'saw rows'; end if; end $d$$q$, 'ok');
select pg_temp.t('admin reads log',          '00000000-0000-0000-0000-00000000000a', $q$do $d$ begin if (select count(*) from public.activity_log where action = 'test') <> 1 then raise exception 'no rows'; end if; end $d$$q$, 'ok');
select pg_temp.t('admin cannot delete log',  '00000000-0000-0000-0000-00000000000a', $q$delete from public.activity_log$q$, 'blocked');
select pg_temp.t('signed-out cannot write log', null, $q$set local role anon; insert into public.activity_log (module, action) values ('x','y')$q$, 'blocked');

-- Profiles
select pg_temp.t('delivery sees only own profile', '00000000-0000-0000-0000-00000000000d', $q$do $d$ begin if (select count(*) from public.profiles) <> 1 then raise exception 'saw %', (select count(*) from public.profiles); end if; end $d$$q$, 'ok');
select pg_temp.t('delivery cannot promote self',   '00000000-0000-0000-0000-00000000000d', $q$update public.profiles set role = 'admin' where id = auth.uid()$q$, 'blocked');

select json_agg(json_build_object('n', n, 'pass', pass, 'test', test, 'expected', expected, 'got', got) order by n) from t_results;
