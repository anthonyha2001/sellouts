-- 048 — Shelf labels: a regular label or a promo paper (owner, 2026-10-04).
--   label_items.kind: 'label' (regular shelf label, as before) or 'promo' (promo paper). The same item can be
--   asked for both: the unique key becomes (list, barcode, kind). Existing items are regular labels.
--   floor_check_send_labels (047): a promotion item that starts or is re-checked asks for a promo paper;
--   anything going back to its normal price, and sell-out items, ask for a regular label.
-- ADDITIVE (new column with a default; the unique key widened; the function replaced).

alter table public.label_items add column if not exists kind text not null default 'label';
alter table public.label_items drop constraint if exists label_items_kind_check;
alter table public.label_items add constraint label_items_kind_check check (kind in ('label', 'promo'));
alter table public.label_items drop constraint if exists label_items_list_id_barcode_key;
alter table public.label_items drop constraint if exists label_items_list_barcode_kind_key;
alter table public.label_items add constraint label_items_list_barcode_kind_key unique (list_id, barcode, kind);

create or replace function public.floor_check_send_labels(p_check uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare c public.floor_checks; lid uuid; n integer;
begin
  select * into c from public.floor_checks where id = p_check;
  if c.id is null then raise exception 'Check not found'; end if;
  if not (c.started_by = auth.uid() or public.has_perm('floorcheck.manage')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  -- the label: the item's first barcode, else its code; a promo paper for a promotion price
  create temp table if not exists fc_lbl (item_id uuid, code text, kind text) on commit drop;
  delete from fc_lbl;
  insert into fc_lbl
  select i.id, coalesce(nullif(split_part(coalesce(i.barcode, ''), ',', 1), ''), i.code),
         case when i.source = 'promotion' and coalesce(i.reason, '') <> 'ends' then 'promo' else 'label' end
    from public.floor_check_items i
   where i.check_id = p_check and i.status in ('wrong_price', 'missing_tag') and i.label_sent_at is null
     and coalesce(nullif(split_part(coalesce(i.barcode, ''), ',', 1), ''), i.code) ~ '^[0-9A-Za-z.\-]{1,64}$';
  select count(*) into n from fc_lbl;
  if n = 0 then return 0; end if;
  insert into public.label_lists (created_by, submitted_at) values (auth.uid(), now()) returning id into lid;
  update public.label_lists set created_by_name = coalesce(created_by_name, 'Someone') || ' (floor check ' || to_char(c.check_date, 'DD/MM') || ')'
   where id = lid;
  insert into public.label_items (list_id, barcode, qty, kind)
  select lid, code, 1, kind from fc_lbl group by code, kind;
  update public.floor_check_items set label_sent_at = now() where id in (select item_id from fc_lbl);
  return n;
end $$;
