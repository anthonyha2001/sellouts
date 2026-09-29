-- Tests for 010. Dry-run only, right after the migration; everything is rolled back:
--   node --env-file=.env scripts/db.mjs supabase/migrations/010_shelf_labels.sql supabase/tests/010_test.sql --dry-run

create temp table t_results (n serial, test text, expected text, got text, pass boolean) on commit drop;
grant all on t_results, t_results_n_seq to authenticated, anon;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin@lvajaltoun.local',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a1', 't_shelf1@lvajaltoun.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 't_shelf2@lvajaltoun.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct@lvajaltoun.local',   'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000f0', 't_floor@lvajaltoun.local',  'authenticated', 'authenticated');
insert into public.profiles (id, username, role, active) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin', 'admin', true),
  ('00000000-0000-0000-0000-0000000000a1', 't_shelf1', 'shelf', true),
  ('00000000-0000-0000-0000-0000000000a2', 't_shelf2', 'shelf', true),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct', 'accountant', true),
  ('00000000-0000-0000-0000-0000000000f0', 't_floor', 'floor_manager', true);

create or replace function pg_temp.t(label text, who text, stmt text, expect text) returns void
language plpgsql as $$
declare got text;
begin
  if who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true); execute 'set local role anon';
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
create or replace function pg_temp.expect(q text, want bigint) returns void
language plpgsql as $$ declare n bigint; begin execute q into n; if n is distinct from want then raise exception 'got %, expected %', n, want; end if; end $$;
create or replace function pg_temp.check(label text, ok boolean) returns void
language sql as $$ insert into t_results (test, expected, got, pass) values (label, 'ok', case when ok then 'ok' else 'failed' end, ok) $$;

-- role
select pg_temp.check('profiles accept the shelf role', exists (select 1 from public.profiles where role = 'shelf'));

-- shelf 1 scans
select pg_temp.t('shelf 1 opens a list', '00000000-0000-0000-0000-0000000000a1',
  $q$insert into public.label_lists (id) values ('40000000-0000-0000-0000-000000000001')$q$, 'ok');
select pg_temp.check('…stamped with the scanner''s name', (select created_by_name = 't_shelf1' from public.label_lists where id = '40000000-0000-0000-0000-000000000001'));
select pg_temp.t('a second open list', '00000000-0000-0000-0000-0000000000a1',
  $q$insert into public.label_lists default values$q$, 'blocked');
select pg_temp.t('shelf 1 scans items', '00000000-0000-0000-0000-0000000000a1',
  $q$insert into public.label_items (list_id, barcode, qty) values ('40000000-0000-0000-0000-000000000001', '0012345678905', 1), ('40000000-0000-0000-0000-000000000001', '5281018709276', 3)$q$, 'ok');
select pg_temp.t('scan again = qty up (upsert)', '00000000-0000-0000-0000-0000000000a1',
  $q$insert into public.label_items (list_id, barcode, qty) values ('40000000-0000-0000-0000-000000000001', '0012345678905', 2) on conflict (list_id, barcode) do update set qty = excluded.qty$q$, 'ok');
select pg_temp.check('…leading zero kept, qty 2', (select qty = 2 from public.label_items where barcode = '0012345678905'));
select pg_temp.t('bad barcode text', '00000000-0000-0000-0000-0000000000a1',
  $q$insert into public.label_items (list_id, barcode) values ('40000000-0000-0000-0000-000000000001', 'abc def')$q$, 'blocked');
select pg_temp.t('qty 0', '00000000-0000-0000-0000-0000000000a1',
  $q$update public.label_items set qty = 0 where barcode = '5281018709276'$q$, 'blocked');

-- nobody else sees an open list
select pg_temp.t('shelf 2 cannot see it', '00000000-0000-0000-0000-0000000000a2', $q$select pg_temp.expect('select count(*) from public.label_items', 0)$q$, 'ok');
select pg_temp.t('shelf 2 cannot add to it', '00000000-0000-0000-0000-0000000000a2',
  $q$insert into public.label_items (list_id, barcode) values ('40000000-0000-0000-0000-000000000001', '111111')$q$, 'blocked');
select pg_temp.t('accountant does not see open lists', '00000000-0000-0000-0000-0000000000ac', $q$select pg_temp.expect('select count(*) from public.label_lists', 0)$q$, 'ok');
select pg_temp.t('floor manager sees nothing', '00000000-0000-0000-0000-0000000000f0', $q$select pg_temp.expect('select count(*) from public.label_lists', 0)$q$, 'ok');
select pg_temp.t('floor manager cannot open a list', '00000000-0000-0000-0000-0000000000f0', $q$insert into public.label_lists default values$q$, 'blocked');
select pg_temp.t('anon reads lists', 'anon', $q$select 1 from public.label_lists$q$, 'blocked');

-- Done
select pg_temp.t('shelf 1 cannot mark exported', '00000000-0000-0000-0000-0000000000a1',
  $q$update public.label_lists set exported_at = now() where id = '40000000-0000-0000-0000-000000000001'$q$, 'blocked');
select pg_temp.t('shelf 1 submits (Done)', '00000000-0000-0000-0000-0000000000a1',
  $q$update public.label_lists set submitted_at = now() where id = '40000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.t('…then cannot add more (silently nothing / blocked)', '00000000-0000-0000-0000-0000000000a1',
  $q$insert into public.label_items (list_id, barcode) values ('40000000-0000-0000-0000-000000000001', '222222')$q$, 'blocked');
select pg_temp.t('…nor reopen it', '00000000-0000-0000-0000-0000000000a1',
  $q$update public.label_lists set submitted_at = null where id = '40000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.check('…still submitted', (select submitted_at is not null from public.label_lists where id = '40000000-0000-0000-0000-000000000001'));
select pg_temp.t('shelf 1 can open a new list now', '00000000-0000-0000-0000-0000000000a1',
  $q$insert into public.label_lists default values$q$, 'ok');

-- accountant exports
select pg_temp.t('accountant sees the submitted list', '00000000-0000-0000-0000-0000000000ac', $q$select pg_temp.expect('select count(*) from public.label_items', 2)$q$, 'ok');
select pg_temp.t('accountant cannot change quantities', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.label_items set qty = 50 where barcode = '5281018709276'$q$, 'ok');
select pg_temp.check('…qty unchanged', (select qty = 3 from public.label_items where barcode = '5281018709276'));
select pg_temp.t('accountant marks it exported', '00000000-0000-0000-0000-0000000000ac',
  $q$update public.label_lists set exported_at = now() where id = '40000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.check('…exported_by stamped', (select exported_by = '00000000-0000-0000-0000-0000000000ac' from public.label_lists where id = '40000000-0000-0000-0000-000000000001'));
select pg_temp.t('accountant cannot delete lists', '00000000-0000-0000-0000-0000000000ac',
  $q$delete from public.label_lists where id = '40000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.check('…list kept', exists (select 1 from public.label_lists where id = '40000000-0000-0000-0000-000000000001'));
select pg_temp.t('admin also scans', '00000000-0000-0000-0000-00000000000a', $q$insert into public.label_lists default values$q$, 'ok');

-- floor check barcode column
select pg_temp.check('floor_check_items.barcode exists', exists (select 1 from information_schema.columns where table_name = 'floor_check_items' and column_name = 'barcode'));

select json_agg(json_build_object('n', n, 'pass', pass, 'test', test, 'expected', expected, 'got', got) order by n) from t_results;
