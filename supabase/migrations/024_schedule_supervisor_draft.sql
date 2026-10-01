-- 024 — Supervisors work on the draft schedule (owner, 2026-10-01): all supervisors edit the same
-- unpublished week from the cashier page (PIN, through the cashier-view function), then "Send to HR";
-- HR reviews and publishes it in the app. Published weeks are read-only for them.
-- ADDITIVE.

alter table public.schedule_weeks add column if not exists submitted_at timestamptz;   -- sent to HR for review
alter table public.schedule_weeks add column if not exists submitted_by text;          -- the supervisor's name
alter table public.schedule_weeks add column if not exists last_editor  text;          -- who changed it last (a supervisor's name, or null = the app)

-- One cell at a time, so supervisors working at the same moment never overwrite each other's days.
-- Only the cashier-view function calls it (service key); it refuses a published week.
create or replace function public.schedule_set_cell(p_week date, p_staff uuid, p_day int, p_code text, p_editor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb; d jsonb; i int;
begin
  if p_day < 0 or p_day > 6 then raise exception 'Bad day'; end if;
  if p_code !~ '^(|off|(am|pm|full)(:(front|back))?(\|[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9])?)$' then raise exception 'Bad shift'; end if;
  select assignments into a from public.schedule_weeks where week_start = p_week and not published for update;
  if not found then raise exception 'This week is published or does not exist' using errcode = '42501'; end if;
  d := coalesce(a -> p_staff::text, '[]'::jsonb);
  for i in jsonb_array_length(d) .. 6 loop d := d || '""'::jsonb; end loop;
  d := jsonb_set(d, array[p_day::text], to_jsonb(p_code));
  update public.schedule_weeks
     set assignments = jsonb_set(coalesce(a, '{}'::jsonb), array[p_staff::text], d), last_editor = p_editor
   where week_start = p_week;
  return d;
end $$;
revoke all on function public.schedule_set_cell(date, uuid, int, text, text) from public, anon, authenticated;
grant execute on function public.schedule_set_cell(date, uuid, int, text, text) to service_role;
