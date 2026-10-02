-- 035 — A full day can have a different station for its AM and PM halves (owner, 2026-10-02):
-- "full:front/back" = AM at the front, PM at the back. The supervisors' draft editor (cashier page)
-- saves cells through schedule_set_cell, whose shift check now accepts it. Same function otherwise (024).
-- ADDITIVE (function replaced, same signature and grants).

create or replace function public.schedule_set_cell(p_week date, p_staff uuid, p_day int, p_code text, p_editor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb; d jsonb; i int;
begin
  if p_day < 0 or p_day > 6 then raise exception 'Bad day'; end if;
  if p_code !~ '^(|off|((am|pm)(:(front|back))?|full(:(front|back)(/(front|back))?)?)(\|[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9])?)$' then raise exception 'Bad shift'; end if;
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
