-- 100 — Notification monitor (owner, 2026-10-25): a read-only view of the cashiers' push health, so the owner can see
--   WHY a cashier isn't getting notifications. The cashier_push_subscriptions / cashier_push_log tables are service-role
--   only (migration 023), so this SECURITY DEFINER function exposes a safe summary to admins (or anyone with cash.view):
--     · per active cashier: how many phones are registered, whether any are failing, the last successful push, when the
--       phone was registered, and the last device's user-agent;
--     · the last 200 pushes actually sent to cashiers (what + when + to whom).
--   No endpoints or keys are ever returned. Read only. ADDITIVE.
create or replace function public.cashier_push_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  res jsonb;
begin
  if not (public.is_role('admin') or public.has_perm('cash.view')) then
    raise exception 'Not allowed';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'cashiers', coalesce((
      select jsonb_agg(x order by x->>'name')
      from (
        select jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'position', c.position,
          'devices', count(s.id),
          'failing', count(s.id) filter (where coalesce(s.failures, 0) > 0),
          'last_ok_at', max(s.last_ok_at),
          'registered_at', max(s.created_at),
          'last_agent', (array_remove(array_agg(s.user_agent order by s.created_at desc), null))[1]
        ) as x
        from public.cashiers c
        left join public.cashier_push_subscriptions s on s.cashier_id = c.id
        where c.active
        group by c.id, c.name, c.position
      ) t
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('key', l.key, 'sent_at', l.sent_at, 'cashier', c.name) order by l.sent_at desc)
      from (select key, cashier_id, sent_at from public.cashier_push_log order by sent_at desc limit 200) l
      join public.cashiers c on c.id = l.cashier_id
    ), '[]'::jsonb)
  ) into res;

  return res;
end
$$;

revoke all on function public.cashier_push_status() from public, anon;
grant execute on function public.cashier_push_status() to authenticated;
