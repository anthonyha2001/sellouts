-- READ-ONLY schema inspection. Changes nothing.
-- Run in Supabase dashboard → SQL Editor, then copy the single JSON cell it returns
-- (click the cell → copy) and paste it back so docs/schema-before.md can be completed.
select jsonb_pretty(jsonb_build_object(
  'tables', (
    select jsonb_agg(jsonb_build_object(
      'table', c.relname,
      'rls_enabled', c.relrowsecurity,
      'rls_forced', c.relforcerowsecurity,
      'est_rows', c.reltuples::bigint
    ) order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
  ),
  'columns', (
    select jsonb_agg(jsonb_build_object(
      'table', table_name, 'column', column_name, 'type', data_type,
      'nullable', is_nullable, 'default', column_default
    ) order by table_name, ordinal_position)
    from information_schema.columns where table_schema = 'public'
  ),
  'constraints', (
    select jsonb_agg(jsonb_build_object(
      'table', conrelid::regclass::text, 'name', conname, 'def', pg_get_constraintdef(oid)
    ) order by conrelid::regclass::text, conname)
    from pg_constraint where connamespace = 'public'::regnamespace
  ),
  'indexes', (
    select jsonb_agg(jsonb_build_object('table', tablename, 'def', indexdef) order by tablename, indexname)
    from pg_indexes where schemaname = 'public'
  ),
  'policies', (
    select jsonb_agg(jsonb_build_object(
      'table', tablename, 'name', policyname, 'cmd', cmd, 'roles', roles,
      'permissive', permissive, 'using', qual, 'with_check', with_check
    ) order by tablename, policyname)
    from pg_policies where schemaname = 'public'
  ),
  'grants', (
    select jsonb_agg(jsonb_build_object('table', table_name, 'grantee', grantee, 'privs', privs) order by table_name, grantee)
    from (
      select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) privs
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon','authenticated')
      group by table_name, grantee
    ) g
  ),
  'triggers', (
    select jsonb_agg(jsonb_build_object('table', event_object_table, 'name', trigger_name,
      'timing', action_timing, 'event', event_manipulation, 'action', action_statement))
    from information_schema.triggers where trigger_schema = 'public'
  ),
  'functions', (
    select jsonb_agg(jsonb_build_object('name', p.proname, 'args', pg_get_function_identity_arguments(p.oid),
      'security_definer', p.prosecdef))
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  ),
  'realtime_tables', (
    select jsonb_agg(schemaname || '.' || tablename) from pg_publication_tables where pubname = 'supabase_realtime'
  ),
  'extensions', (select jsonb_agg(extname || ' ' || extversion) from pg_extension),
  'storage_buckets', (select jsonb_agg(jsonb_build_object('id', id, 'public', public)) from storage.buckets),
  'auth_user_count', (select count(*) from auth.users)
)) as schema_report;
