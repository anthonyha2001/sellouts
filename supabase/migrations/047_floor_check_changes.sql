-- 047 — A shorter, more useful floor check (owner, 2026-10-04).
--   floor_checks.mode: 'changes' (new default in the app: only what changed since the last check — items
--     starting, items ending (back to the normal price), and last time's problems still open) or 'full'
--     (every item running today, as before; the checks made until now).
--   floor_check_items.reason: why an item is on the list — 'starts', 'ends', 'recheck' or 'running'.
--   floor_check_items.label_sent_at: when a wrong price / missing tag was sent to the shelf labels.
--   floor_check_send_labels(check): the check's wrong prices and missing tags become a shelf-label list,
--     already sent to the accountant ("To print"), once per item. For the floor manager who did the check
--     (they cannot make label lists themselves) and for floorcheck.manage.
-- ADDITIVE.

alter table public.floor_checks add column if not exists mode text not null default 'full';
alter table public.floor_checks drop constraint if exists floor_checks_mode_check;
alter table public.floor_checks add constraint floor_checks_mode_check check (mode in ('changes', 'full'));
alter table public.floor_check_items add column if not exists reason text;
alter table public.floor_check_items add column if not exists label_sent_at timestamptz;

create or replace function public.floor_check_send_labels(p_check uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare c public.floor_checks; lid uuid; n integer;
begin
  select * into c from public.floor_checks where id = p_check;
  if c.id is null then raise exception 'Check not found'; end if;
  if not (c.started_by = auth.uid() or public.has_perm('floorcheck.manage')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  -- the label: the item's first barcode, else its code
  create temp table if not exists fc_lbl (item_id uuid, code text) on commit drop;
  delete from fc_lbl;
  insert into fc_lbl
  select i.id, coalesce(nullif(split_part(coalesce(i.barcode, ''), ',', 1), ''), i.code)
    from public.floor_check_items i
   where i.check_id = p_check and i.status in ('wrong_price', 'missing_tag') and i.label_sent_at is null
     and coalesce(nullif(split_part(coalesce(i.barcode, ''), ',', 1), ''), i.code) ~ '^[0-9A-Za-z.\-]{1,64}$';
  select count(*) into n from fc_lbl;
  if n = 0 then return 0; end if;
  insert into public.label_lists (created_by, submitted_at) values (auth.uid(), now()) returning id into lid;
  update public.label_lists set created_by_name = coalesce(created_by_name, 'Someone') || ' (floor check ' || to_char(c.check_date, 'DD/MM') || ')'
   where id = lid;
  insert into public.label_items (list_id, barcode, qty)
  select lid, code, 1 from fc_lbl group by code;
  update public.floor_check_items set label_sent_at = now() where id in (select item_id from fc_lbl);
  return n;
end $$;
revoke execute on function public.floor_check_send_labels(uuid) from public, anon;
grant execute on function public.floor_check_send_labels(uuid) to authenticated;
