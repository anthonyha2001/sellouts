-- Tests for 006. Dry-run only, right after the migration; everything is rolled back:
--   node --env-file=.env scripts/db.mjs supabase/migrations/006_floor_check.sql supabase/tests/006_test.sql --dry-run

create temp table t_results (n serial, test text, expected text, got text, pass boolean) on commit drop;
grant all on t_results, t_results_n_seq to authenticated, anon;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin@lvajaltoun.local',  'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000f1', 't_floor1@lvajaltoun.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000f2', 't_floor2@lvajaltoun.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct@lvajaltoun.local',   'authenticated', 'authenticated');
insert into public.profiles (id, username, role, active) values
  ('00000000-0000-0000-0000-00000000000a', 't_admin', 'admin', true),
  ('00000000-0000-0000-0000-0000000000f1', 't_floor1', 'floor_manager', true),
  ('00000000-0000-0000-0000-0000000000f2', 't_floor2', 'floor_manager', true),
  ('00000000-0000-0000-0000-0000000000ac', 't_acct', 'accountant', true);

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

-- ---------- starting checks ----------
select pg_temp.t('floor 1 starts today''s check', '00000000-0000-0000-0000-0000000000f1',
  $q$insert into public.floor_checks (id) values ('20000000-0000-0000-0000-000000000001')$q$, 'ok');
select pg_temp.check('…dated today (Beirut), owned by floor 1',
  (select check_date = public.beirut_today() and started_by = '00000000-0000-0000-0000-0000000000f1' from public.floor_checks where id = '20000000-0000-0000-0000-000000000001'));
select pg_temp.t('a second check the same day', '00000000-0000-0000-0000-0000000000f1',
  $q$insert into public.floor_checks default values$q$, 'blocked');
select pg_temp.t('floor 1 starts a check for someone else', '00000000-0000-0000-0000-0000000000f1',
  $q$insert into public.floor_checks (started_by) values ('00000000-0000-0000-0000-0000000000f2')$q$, 'blocked');
select pg_temp.t('accountant starts a check', '00000000-0000-0000-0000-0000000000ac',
  $q$insert into public.floor_checks default values$q$, 'blocked');
select pg_temp.t('floor 2 starts own check', '00000000-0000-0000-0000-0000000000f2',
  $q$insert into public.floor_checks (id) values ('20000000-0000-0000-0000-000000000002')$q$, 'ok');
select pg_temp.t('floor 1 adds items', '00000000-0000-0000-0000-0000000000f1',
  $q$insert into public.floor_check_items (id, check_id, item_row, code, description, expected_price) values
     ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 0, '151540', 'Test item', 1.35),
     ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 1, '00123', 'Other item', 2.80)$q$, 'ok');
select pg_temp.t('floor 2 adds items to floor 1''s check', '00000000-0000-0000-0000-0000000000f2',
  $q$insert into public.floor_check_items (check_id, item_row, code) values ('20000000-0000-0000-0000-000000000001', 9, 'x')$q$, 'blocked');

-- ---------- who sees what ----------
select pg_temp.t('floor 1 sees only own check', '00000000-0000-0000-0000-0000000000f1', $q$select pg_temp.expect('select count(*) from public.floor_checks', 1)$q$, 'ok');
select pg_temp.t('floor 2 sees none of floor 1''s items', '00000000-0000-0000-0000-0000000000f2', $q$select pg_temp.expect('select count(*) from public.floor_check_items', 0)$q$, 'ok');
select pg_temp.t('accountant sees no checks', '00000000-0000-0000-0000-0000000000ac', $q$select pg_temp.expect('select count(*) from public.floor_checks', 0)$q$, 'ok');
select pg_temp.t('admin sees both checks', '00000000-0000-0000-0000-00000000000a', $q$select pg_temp.expect('select count(*) from public.floor_checks', 2)$q$, 'ok');
select pg_temp.t('anon reads checks', 'anon', $q$select 1 from public.floor_checks$q$, 'blocked');

-- ---------- checking ----------
select pg_temp.t('floor 1 marks wrong price', '00000000-0000-0000-0000-0000000000f1',
  $q$update public.floor_check_items set status = 'wrong_price', note = 'Shelf shows 1.70' where id = '30000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.check('…stamped checked_by/at',
  (select checked_by = '00000000-0000-0000-0000-0000000000f1' and checked_at is not null from public.floor_check_items where id = '30000000-0000-0000-0000-000000000001'));
select pg_temp.t('floor 1 marks resolved', '00000000-0000-0000-0000-0000000000f1',
  $q$update public.floor_check_items set resolved = true where id = '30000000-0000-0000-0000-000000000001'$q$, 'blocked');
select pg_temp.t('floor 2 edits floor 1''s item (silently nothing)', '00000000-0000-0000-0000-0000000000f2',
  $q$update public.floor_check_items set status = 'ok' where id = '30000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.check('…item unchanged', (select status = 'wrong_price' from public.floor_check_items where id = '30000000-0000-0000-0000-000000000001'));
select pg_temp.t('bad status value', '00000000-0000-0000-0000-0000000000f1',
  $q$update public.floor_check_items set status = 'broken' where id = '30000000-0000-0000-0000-000000000002'$q$, 'blocked');

-- ---------- finishing ----------
select pg_temp.t('floor 1 finishes', '00000000-0000-0000-0000-0000000000f1',
  $q$update public.floor_checks set completed_at = now(), summary = '{"ok":0,"wrong_price":1,"pending":1}' where id = '20000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.t('floor 1 changes an item after finishing', '00000000-0000-0000-0000-0000000000f1',
  $q$update public.floor_check_items set status = 'ok' where id = '30000000-0000-0000-0000-000000000002'$q$, 'blocked');
select pg_temp.t('floor 1 reopens the check', '00000000-0000-0000-0000-0000000000f1',
  $q$update public.floor_checks set completed_at = null where id = '20000000-0000-0000-0000-000000000001'$q$, 'blocked');
select pg_temp.t('floor 1 moves the check date', '00000000-0000-0000-0000-0000000000f1',
  $q$update public.floor_checks set check_date = check_date - 1 where id = '20000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.check('…date did not move', (select check_date = public.beirut_today() from public.floor_checks where id = '20000000-0000-0000-0000-000000000001'));
select pg_temp.t('admin resolves the problem', '00000000-0000-0000-0000-00000000000a',
  $q$update public.floor_check_items set resolved = true where id = '30000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.check('…resolved_by/at stamped',
  (select resolved_by = '00000000-0000-0000-0000-00000000000a' and resolved_at is not null from public.floor_check_items where id = '30000000-0000-0000-0000-000000000001'));
select pg_temp.t('floor 1 deletes an item', '00000000-0000-0000-0000-0000000000f1',
  $q$delete from public.floor_check_items where id = '30000000-0000-0000-0000-000000000002'$q$, 'ok');
select pg_temp.check('…nothing deleted (admin only)', exists (select 1 from public.floor_check_items where id = '30000000-0000-0000-0000-000000000002'));

-- ---------- photos ----------
select pg_temp.t('floor 1 uploads into own folder', '00000000-0000-0000-0000-0000000000f1',
  $q$insert into storage.objects (bucket_id, name, owner) values ('floor-photos', '00000000-0000-0000-0000-0000000000f1/20000000-0000-0000-0000-000000000001/a.jpg', auth.uid())$q$, 'ok');
select pg_temp.t('floor 1 uploads into floor 2''s folder', '00000000-0000-0000-0000-0000000000f1',
  $q$insert into storage.objects (bucket_id, name, owner) values ('floor-photos', '00000000-0000-0000-0000-0000000000f2/x/b.jpg', auth.uid())$q$, 'blocked');
select pg_temp.t('floor 2 cannot see floor 1''s photo', '00000000-0000-0000-0000-0000000000f2',
  $q$select pg_temp.expect($x$select count(*) from storage.objects where bucket_id = 'floor-photos'$x$, 0)$q$, 'ok');
select pg_temp.t('admin sees the photo', '00000000-0000-0000-0000-00000000000a',
  $q$select pg_temp.expect($x$select count(*) from storage.objects where bucket_id = 'floor-photos'$x$, 1)$q$, 'ok');
select pg_temp.t('accountant uploads a photo', '00000000-0000-0000-0000-0000000000ac',
  $q$insert into storage.objects (bucket_id, name, owner) values ('floor-photos', '00000000-0000-0000-0000-0000000000ac/c.jpg', auth.uid())$q$, 'blocked');
select pg_temp.check('bucket is private', (select not public from storage.buckets where id = 'floor-photos'));

select json_agg(json_build_object('n', n, 'pass', pass, 'test', test, 'expected', expected, 'got', got) order by n) from t_results;
