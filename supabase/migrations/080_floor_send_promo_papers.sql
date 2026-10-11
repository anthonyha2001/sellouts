-- 080 — Floor check › Today: the floor manager sends items to the accountant for printing (owner, 2026-10-11).
-- floor_send_promo_papers(items, kind): one submitted list in Shelf labels > To print, named "Name (floor check DD/MM)",
-- with one line per code: kind 'promo' (a promo paper) or 'label' (a regular shelf label). Needs floorcheck.do or
-- floorcheck.manage; the caller does not need labels.scan (the function writes the list for them). Additive: one function.

create or replace function public.floor_send_promo_papers(p_items jsonb, p_kind text default 'promo') returns integer
language plpgsql security definer set search_path = public as $$
declare lid uuid; n integer; nm text;
begin
  if not public.has_perm('floorcheck.do', 'floorcheck.manage') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_kind not in ('promo', 'label') then raise exception 'Unknown type' using errcode = '22023'; end if;
  create temp table if not exists fr_codes (code text) on commit drop;
  delete from fr_codes;
  insert into fr_codes
  select distinct c from (select trim(x ->> 'code') as c from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x) s
   where c ~ '^[0-9A-Za-z.\-]{1,64}$';
  select count(*) into n from fr_codes;
  if n = 0 then return 0; end if;
  select coalesce(nullif(display_name, ''), username) into nm from public.profiles where id = auth.uid();
  insert into public.label_lists (created_by, submitted_at) values (auth.uid(), now()) returning id into lid;
  update public.label_lists
     set created_by_name = coalesce(nm, 'Floor manager') || ' (floor check ' || to_char((now() at time zone 'Asia/Beirut')::date, 'DD/MM') || ')'
   where id = lid;
  insert into public.label_items (list_id, barcode, kind, qty) select lid, code, p_kind, 1 from fr_codes;
  return n;
end $$;
revoke execute on function public.floor_send_promo_papers(jsonb, text) from public, anon;
grant execute on function public.floor_send_promo_papers(jsonb, text) to authenticated;
