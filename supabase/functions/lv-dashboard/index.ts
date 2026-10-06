// lv-dashboard — the app's read-only link to the La Valeur Dashboard (dashboard.lavaleursupermarche.com) (owner, 2026-10-06).
// The dashboard's login is a server secret (LV_DASH_USER / LV_DASH_PASS, typed by the owner, never in the code or the
// browser). This function logs in (POST /api/lavaleur/auth/token), keeps the token (about a day) and logs in again when
// it expires, and answers only what the app needs:
//   POST { action: 'status' }                         -> { ok, user, expires_at }      admin (or the server key): the link works
//   POST { action: 'item_search', search, branch? }   -> { items: [...] }               code / barcode / name -> code, barcodes, description, stock
//   POST { action: 'items_stock', codes: [...] }      -> { stock: { code: qty|null } }  up to 300 codes (exact code match)
// Callers: a signed-in, active app user (Authorization: Bearer <their session>). Read only: nothing is ever written there.
// Deploy with JWT verification OFF (the user is checked here).
import { createClient } from 'npm:@supabase/supabase-js@2';

const BASE = 'https://dashboard.lavaleursupermarche.com/api/lavaleur';
const BRANCH = 'Ajaltoun';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('LV_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// The server's own keys (for a check from the server side only).
function serverKeys(): string[] {
  const out = [Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''];
  try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); Object.values(k).forEach(v => out.push(String(v))); } catch { /* not JSON */ }
  return out.filter(Boolean);
}

/* ---------------- the dashboard's token ---------------- */
let token: string | null = null, tokenExp = 0;
// "eyJleHAiOjE3OTEyNjExNDgsInN1YiI6Ii4uLiJ9.signature": the first part says when it expires.
function expOf(t: string): number {
  try { const p = JSON.parse(atob(t.split('.')[0])); return Number(p.exp) * 1000 || 0; } catch { return 0; }
}
async function login(): Promise<string> {
  const username = Deno.env.get('LV_DASH_USER'), password = Deno.env.get('LV_DASH_PASS');
  if (!username || !password) throw new Error('The dashboard login is not set (server secrets).');
  const r = await fetch(`${BASE}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ username, password }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Dashboard login refused (${r.status})`);
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(text); } catch { /* the token as plain text */ }
  const t = String(d.access_token ?? d.token ?? (d.data as Record<string, unknown>)?.access_token ?? (d.data as Record<string, unknown>)?.token ?? (text.startsWith('ey') ? text : ''));
  if (!t) throw new Error('Dashboard login: no token in the answer');
  token = t; tokenExp = expOf(t) || Date.now() + 6 * 3600e3;
  return t;
}
// one login at a time: parallel requests wait for the same one (16 at once used to log in 16 times)
let loggingIn: Promise<string> | null = null;
function ensureLogin(): Promise<string> | null {
  if (token && Date.now() <= tokenExp - 5 * 60e3) return null;
  if (!loggingIn) loggingIn = login().finally(() => { loggingIn = null; });
  return loggingIn;
}
async function dash(path: string, init: RequestInit = {}, retry = true, tries = 2): Promise<unknown> {
  const wait = ensureLogin(); if (wait) await wait;
  let r: Response;
  try {   // a request that hangs is given up after 25 s and tried once more
    r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(25000), headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  } catch (e) {
    if (tries > 1) return dash(path, init, retry, tries - 1);
    throw e;
  }
  if (r.status === 401 && retry) { token = null; return dash(path, init, false, tries); }
  if ((r.status === 429 || r.status >= 500) && tries > 1) { await new Promise(res => setTimeout(res, 800)); return dash(path, init, retry, tries - 1); }
  if (r.ok && path.startsWith('/item-price-checker')) {
    const j = await r.json() as Record<string, unknown>;
    const br = (j.branches as Record<string, unknown> || {})[BRANCH];
    if (typeof br === 'string') {
      if (tries > 1) { await new Promise(res => setTimeout(res, 500)); return dash(path, init, retry, tries - 1); }
      throw new Error('Dashboard: ' + br.slice(0, 120));
    }
    return j;
  }
  if (!r.ok) throw new Error(`Dashboard answered ${r.status}${r.status === 422 ? ": " + (await r.text()).slice(0, 300) : ""}`);
  return r.json();
}
// The normal UNIT price (owner, 2026-10-06): SalePrice is the price of the whole pack (7721 Tahina: pack 12, 82.20);
// SalePrice2 is the unit price (6.85). Else SalePrice / Pack.
function unitSale(h: Record<string, unknown>): number | null {
  if (h.SalePrice2 !== null && h.SalePrice2 !== undefined && h.SalePrice2 !== '') return Number(h.SalePrice2);
  if (h.SalePrice === null || h.SalePrice === undefined) return null;
  const pack = Number(h.Pack || 1);
  return pack > 1 ? Math.round(Number(h.SalePrice) / pack * 10000) / 10000 : Number(h.SalePrice);
}
const year = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' }).slice(0, 4);
type Item = { code: string; barcode?: string; barcodes?: string[]; description?: string; description4?: string; available_quantity?: number | null; available_quantity_branch?: string };
const slim = (i: Item) => ({ code: String(i.code ?? ''), barcodes: i.barcodes || (i.barcode ? [i.barcode] : []), description: i.description || '', size: i.description4 || '', stock: i.available_quantity ?? null, branch: i.available_quantity_branch || BRANCH });
async function search(q: string, branch = BRANCH): Promise<Item[]> {
  const p = new URLSearchParams({ search: q, year: year(), preferred_branch: branch });
  const d = await dash(`/items/search?${p}`);
  return Array.isArray(d) ? d as Item[] : [];
}

/* ---------------- price watch (owner, 2026-10-06; migration 064) ----------------
   The items of the running sell-outs (not online-only) and promotions; up to `limit` of them not read in the
   last 20 hours get their price read now. A price (or normal price) not the one kept = changed_at / prev_*. */
async function priceWatch(limit: number) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
  const watch = new Map<string, Record<string, unknown>[]>();
  const add = (code: unknown, src: Record<string, unknown>) => {
    const c = String(code ?? '').trim(); if (!c || c.length > 30) return;
    const l = watch.get(c) || []; if (!l.some(x => x.kind === src.kind && x.id === src.id)) l.push(src); watch.set(c, l);
  };
  const { data: so, error: e1 } = await db.from('sellouts').select('id, name, supplier, from, to, active, archived, online, items, priced_items');
  if (e1) throw e1;
  (so || []).filter(s => !s.archived && !s.online && (s.active || (s.from <= today && today <= s.to))).forEach(s => {
    const src = { kind: 'sellout', id: s.id, name: s.name, supplier: s.supplier || '' };
    if (Array.isArray(s.priced_items) && s.priced_items.length) s.priced_items.forEach((p: Record<string, unknown>) => add(p.code, src));
    else (Array.isArray(s.items) ? s.items : []).forEach((r: Record<string, unknown>) => {
      const k = Object.keys(r).find(x => /^(code|item|item ?code|itemcode)$/i.test(x.trim())) || Object.keys(r)[0];
      add(k ? r[k] : '', src);
    });
  });
  const { data: pr, error: e2 } = await db.from('promotions').select('id, name, from_date, to_date, archived').eq('archived', false).lte('from_date', today).gte('to_date', today);
  if (e2) throw e2;
  if (pr?.length) {
    const { data: rows, error: e3 } = await db.from('promotion_rows').select('promotion_id, code, supplier').in('promotion_id', pr.map(p => p.id));
    if (e3) throw e3;
    (rows || []).forEach(r => { const p = pr.find(x => x.id === r.promotion_id); if (p) add(r.code, { kind: 'promotion', id: p.id, name: p.name || 'Promotion', supplier: r.supplier || '' }); });
  }
  const codes = [...watch.keys()];
  // what we already know
  const known = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < codes.length; i += 500) {
    const { data, error } = await db.from('item_price_watch').select('code, price, sale_price, checked_at').in('code', codes.slice(i, i + 500));
    if (error) throw error;
    (data || []).forEach(r => known.set(r.code, r));
  }
  const stale = Date.now() - 20 * 3600e3;
  const due = codes.filter(c => { const k = known.get(c); return !k || !k.checked_at || new Date(String(k.checked_at)).getTime() < stale; }).slice(0, Math.min(300, Math.max(1, limit)));
  const keyOf = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
  let changed = 0, read = 0;
  const y = year();
  for (let i = 0; i < due.length; i += 6) {
    await Promise.all(due.slice(i, i + 6).map(async c => {
      try {
        const d = await dash(`/item-price-checker?${new URLSearchParams({ search: c, year: y, branches: BRANCH })}`) as Record<string, unknown>;
        const br = ((d.branches as Record<string, Record<string, unknown[]>>) || {})[BRANCH] || {};
        const hit = (Object.values(br).flat() as Record<string, unknown>[]).find(r => keyOf(String(r.ItemCode ?? '')) === keyOf(c));
        const now = new Date().toISOString(), k = known.get(c);
        const row: Record<string, unknown> = { code: c, sources: watch.get(c), checked_at: now };
        if (hit) {
          const price = hit.Price === null || hit.Price === undefined ? null : Number(hit.Price), sale = unitSale(hit);
          const grp = [String(hit.Group ?? '').trim(), String(hit['Sub-Group'] ?? '').trim()].filter(Boolean).join(' › ');
          Object.assign(row, { description: String(hit.Description ?? '').trim(), price, sale_price: sale, promoted: !!Number(hit.isPromoted || 0), category: grp || null });
          const diff = (a: unknown, b: unknown) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) >= 0.005;
          if (k && (diff(k.price, price) || diff(k.sale_price, sale))) { Object.assign(row, { changed_at: now, prev_price: k.price, prev_sale_price: k.sale_price }); changed++; }
        }
        const { error } = await db.from('item_price_watch').upsert(row);
        if (error) console.warn('watch save', c, error.message); else read++;
      } catch (e) { console.warn('watch', c, e); }
    }));
  }
  // keep the sources of the ones not read this round up to date
  const rest = codes.filter(c => !due.includes(c) && known.has(c));
  for (let i = 0; i < rest.length; i += 200) {
    await Promise.all(rest.slice(i, i + 200).map(c => db.from('item_price_watch').update({ sources: watch.get(c) }).eq('code', c)));
  }
  return { watched: codes.length, read, changed, left: codes.filter(c => !known.has(c) || !known.get(c)!.checked_at || new Date(String(known.get(c)!.checked_at)).getTime() < stale).length - due.length };
}

/* ---------------- stock watch (owner, 2026-10-06; migration 066) ----------------
   One round: the watched vendor(s) checked longest ago (or one vendor), within about 110 item lookups. Its items
   that sold in the last 30 days, their stock now; low = stock <= 0, or days of stock < cover days. */
async function stockWatch(onlyVendor?: string) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
  const from = new Date(new Date(today + 'T00:00:00Z').getTime() - 29 * 864e5).toISOString().slice(0, 10);
  let q = db.from('vendors').select('id, name, lead_time_days, system_suppliers, cover_days, stock_checked_at').eq('watch_stock', true);
  if (onlyVendor) q = q.eq('id', onlyVendor);
  const { data: vs, error } = await q.order('stock_checked_at', { ascending: true, nullsFirst: true });
  if (error) throw error;
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
  let budget = 110; const done: Record<string, unknown>[] = [];
  for (const v of vs || []) {
    const sups = (Array.isArray(v.system_suppliers) ? v.system_suppliers : []).map((s: Record<string, unknown>) => String(s.code || '')).filter(Boolean);
    if (!sups.length) continue;
    if (budget <= 0 && done.length) break;
    // what sold in the last 30 days (the only items watched: no sales = not followed)
    const sold = new Map<string, { code: string; description: string; qty: number }>();
    for (const [f, t] of from.slice(0, 4) === today.slice(0, 4) ? [[from, today]] : [[from, `${from.slice(0, 4)}-12-31`], [`${today.slice(0, 4)}-01-01`, today]]) {
      const rows = await yearRows('/items_sales', { branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Monthly', group_by: ['item'], supplier: sups });
      rows.forEach(r => { const c = String(r.item ?? '').trim(); if (!c || c.includes(':')) return; const it = sold.get(c) || { code: c, description: String(r.item_desc ?? '').trim(), qty: 0 }; it.qty += Number(r.total_quantity || 0); sold.set(c, it); });
    }
    const items = [...sold.values()].filter(i => i.qty > 0).sort((a, b) => b.qty - a.qty).slice(0, 150);
    const cover = Number(v.cover_days) > 0 ? Number(v.cover_days) : (Number(v.lead_time_days) > 0 ? Number(v.lead_time_days) : 3) + 4;
    const low: Record<string, unknown>[] = [];
    for (let i = 0; i < items.length; i += 6) {
      await Promise.all(items.slice(i, i + 6).map(async it => {
        try {
          const d = await dash(`/items/search?${new URLSearchParams({ search: it.code, year: year(), preferred_branch: BRANCH })}`);
          const hit = (Array.isArray(d) ? d : []).find((x: Record<string, unknown>) => key(String(x.code ?? '')) === key(it.code)) as Record<string, unknown> | undefined;
          if (!hit || hit.available_quantity === null || hit.available_quantity === undefined) return;
          const stock = Number(hit.available_quantity), perDay = it.qty / 30, daysLeft = perDay > 0 ? stock / perDay : null;
          if (stock <= 0 || (daysLeft !== null && daysLeft < cover)) low.push({ vendor_id: v.id, code: it.code, description: it.description || String(hit.description || ''),
            stock, sold30: it.qty, per_day: Math.round(perDay * 100) / 100, days_left: daysLeft === null ? null : Math.round(daysLeft * 10) / 10, cover_days: cover });
        } catch (e) { console.warn('stock', it.code, e); }
      }));
    }
    budget -= items.length;
    // keep the open ones, add the new ones, resolve the ones back above
    const { data: open } = await db.from('stock_alerts').select('code').eq('vendor_id', v.id).is('resolved_at', null);
    const now = new Date().toISOString(), lowCodes = new Set(low.map(x => String(x.code))), openCodes = new Set((open || []).map(x => x.code));
    for (const x of low) {
      if (openCodes.has(String(x.code))) await db.from('stock_alerts').update({ ...x, last_seen: now }).eq('vendor_id', v.id).eq('code', x.code);
      else await db.from('stock_alerts').upsert({ ...x, first_seen: now, last_seen: now, resolved_at: null });
    }
    const back = [...openCodes].filter(c => !lowCodes.has(c) && items.some(i => i.code === c));
    if (back.length) await db.from('stock_alerts').update({ resolved_at: now }).eq('vendor_id', v.id).in('code', back);
    await db.from('vendors').update({ stock_checked_at: now }).eq('id', v.id);
    done.push({ vendor: v.name, items: items.length, low: low.length, newlyLow: low.filter(x => !openCodes.has(String(x.code))).length, backAbove: back.length });
  }
  return { checked: done };
}

/* ---------------- codes across years (owner, 2026-10-06; migration 069) ----------------
   The system numbers its items AND its suppliers per year: a year's sales and purchases only know that year's codes
   (Abboud trading 0768 in 2025 / 1134 in 2026; Taanayel labneh 400g 016580 / 128420), while the app uses today's.
   code_map (built once per past year: items by barcode, suppliers by name) translates. Every report reaching into a
   past year goes through yearRows(): today's codes in, today's codes out. A code with no match in that year gets no
   rows (never another item's or supplier's figures); a year whose codes are not prepared is an error, not a guess. */
const trimCode = (c: unknown) => String(c ?? '').trim();
const postJson = (b: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const supNameKey = (s: unknown) => String(s || '').toUpperCase().replace(/\(\s*[\d\s]+\)/g, ' ').replace(/\b\d{5,}\b/g, ' ')
  .replace(/\bS\.?\s*A\.?\s*R\.?\s*L\.?(?![A-Z])|\bS\.?\s*A\.?\s*L\.?(?![A-Z])|\bS\.?\s*A\.?(?![A-Z])|\bETS\b\.?|\bSTE\b\.?|\bSOCIETE\b/g, ' ').replace(/[^A-Z0-9؀-ۿ]/g, '');
const mapReady: Record<string, number> = {};
async function ensureYearMap(yr: string) {
  if (mapReady[yr] && Date.now() - mapReady[yr] < 3600e3) return;
  const { count, error } = await db.from('code_map').select('code', { count: 'exact', head: true }).eq('year', Number(yr));
  if (error) throw error;
  if (!count) throw new Error('The codes of ' + yr + ' are not prepared yet (the system renumbers its items each year).');
  mapReady[yr] = Date.now();
}
// today's codes -> that year's: { today: [codes in yr] }
async function toYear(kind: 'item' | 'supplier', codes: string[], yr: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}, list = [...new Set(codes.map(trimCode).filter(Boolean))];
  if (yr === year()) { list.forEach(c => { out[c] = [c]; }); return out; }
  await ensureYearMap(yr);
  for (let i = 0; i < list.length; i += 150) {
    const part = list.slice(i, i + 150);
    const { data, error } = await db.from('code_map').select('code, current_codes').eq('year', Number(yr)).eq('kind', kind).overlaps('current_codes', part);
    if (error) throw error;
    (data || []).forEach(r => (r.current_codes as string[]).forEach(cc => { if (part.includes(cc)) (out[cc] = out[cc] || []).push(String(r.code)); }));
  }
  return out;
}
// that year's codes -> today's: { yrCode: todayCode } (one of the asked codes first, when several)
async function fromYear(kind: 'item' | 'supplier', codes: string[], yr: string, prefer?: Set<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}, list = [...new Set(codes.map(trimCode).filter(Boolean))];
  if (yr === year()) { list.forEach(c => { out[c] = c; }); return out; }
  if (!list.length) return out;
  await ensureYearMap(yr);
  for (let i = 0; i < list.length; i += 300) {
    const { data, error } = await db.from('code_map').select('code, current_codes').eq('year', Number(yr)).eq('kind', kind).in('code', list.slice(i, i + 300));
    if (error) throw error;
    (data || []).forEach(r => { const cc = (r.current_codes as string[]) || []; const pick = (prefer && cc.find(x => prefer.has(x))) || cc[0]; if (pick) out[String(r.code)] = pick; });
  }
  return out;
}
// one report request for one year (body.year): today's codes in (supplier / item), today's codes out (r.item, r.supplier;
// that year's own code kept in r._yrItem). Unmatched rows keep 'yyyy:code' so they never merge with today's items.
async function yearRows(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const yr = String(body.year);
  if (yr === year()) { const rows = branchRows(await dash(path, postJson(body))); rows.forEach(r => { if (r.item) { r.item = trimCode(r.item); r._yrItem = r.item; } if (r.supplier) r.supplier = trimCode(r.supplier); }); return rows; }
  const b: Record<string, unknown> = { ...body };
  const prefItems = new Set<string>(), prefSups = new Set<string>();
  for (const [field, kind] of [['supplier', 'supplier'], ['item', 'item']] as const) {
    if (!Array.isArray(b[field])) continue;
    const asked = (b[field] as unknown[]).map(trimCode);
    const m = await toYear(kind, asked, yr), list = [...new Set(Object.values(m).flat())];
    if (!list.length) return [];
    asked.forEach(c => (kind === 'item' ? prefItems : prefSups).add(c));
    b[field] = list;
  }
  const rows = branchRows(await dash(path, postJson(b)));
  const [im, sm] = await Promise.all([
    fromYear('item', rows.map(r => trimCode(r.item)).filter(Boolean), yr, prefItems),
    fromYear('supplier', rows.map(r => trimCode(r.supplier)).filter(Boolean), yr, prefSups) ]);
  rows.forEach(r => {
    if (r.item) { const t = trimCode(r.item); r._yrItem = t; r.item = im[t] || yr + ':' + t; }
    if (r.supplier) { const t = trimCode(r.supplier); r.supplier = sm[t] || yr + ':' + t; }
  });
  return rows;
}

/* building code_map for a past year (server key / admin; once, then again only if wanted) */
async function buildCodeMap(yr: string, part: string, offset = 0) {
  if (!/^\d{4}$/.test(yr) || yr >= year()) throw new Error('Only a past year.');
  const cy = year(), today = beirutToday();
  const whole = (y: string, extra: Record<string, unknown>) => ({ branches: [BRANCH], year: y, from_date: y + '-01-01', to_date: y === cy ? today : y + '-12-31', aggregation: 'Monthly', ...extra });
  const upsert = async (rows: Record<string, unknown>[]) => { for (let i = 0; i < rows.length; i += 1000) { const { error } = await db.from('code_map').upsert(rows.slice(i, i + 1000)); if (error) throw error; } };
  if (part === 'suppliers') {
    const past = new Map<string, string>();
    for (const path of ['/items_purchases', '/items_sales']) branchRows(await dash(path, postJson(whole(yr, { group_by: ['supplier'] })))).forEach(r => { const c = trimCode(r.supplier); if (c && !past.has(c)) past.set(c, String(r.supplier_desc || '').trim()); });
    const cur = new Map<string, Set<string>>();
    const add = (c: string, n: unknown) => { const k = supNameKey(n); if (!k || !c) return; if (!cur.has(k)) cur.set(k, new Set()); cur.get(k)!.add(c); };
    for (const path of ['/items_purchases', '/items_sales']) branchRows(await dash(path, postJson(whole(cy, { group_by: ['supplier'] })))).forEach(r => add(trimCode(r.supplier), r.supplier_desc));
    for (const q of 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) {
      try { const d = await dash('/items/filter-options/supplier?' + new URLSearchParams({ year: cy, limit: '1000', q })) as Record<string, unknown>;
        (((d.data as Record<string, unknown>)?.options || []) as Record<string, unknown>[]).forEach(o => add(trimCode(o.code), o.description ?? o.label)); } catch (e) { console.warn('suppliers', q, e); }
    }
    const rows = [...past.entries()].map(([code, name]) => { const cc = [...(cur.get(supNameKey(name)) || [])]; return { year: Number(yr), kind: 'supplier', code, name, current_codes: cc, how: cc.length ? 'name' : 'not found', built_at: new Date().toISOString() }; });
    await upsert(rows);
    return { year: yr, part, suppliers: rows.length, matched: rows.filter(r => r.current_codes.length).length };
  }
  if (part === 'items') {
    const pastSum = (((await dash('/items_sales/summary', postJson(whole(yr, { group_by: ['item'] }))) as Record<string, unknown>).data as Record<string, unknown>)?.items || []) as Record<string, unknown>[];
    const pastBuy = branchRows(await dash('/items_purchases', postJson(whole(yr, { group_by: ['item'] }))));
    const curSum = (((await dash('/items_sales/summary', postJson(whole(cy, { group_by: ['item'] }))) as Record<string, unknown>).data as Record<string, unknown>)?.items || []) as Record<string, unknown>[];
    const curBuy = branchRows(await dash('/items_purchases', postJson(whole(cy, { group_by: ['item'] }))));
    const byBc = new Map<string, string>(), byDesc = new Map<string, Set<string>>();
    const dk = (s: unknown) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
    curSum.forEach(r => { const c = trimCode(r.item), bc = trimCode(r.barcode); if (c && bc) byBc.set(bc, c); });
    [...curSum, ...curBuy].forEach(r => { const c = trimCode(r.item), d = dk(r.item_desc); if (!c || !d) return; if (!byDesc.has(d)) byDesc.set(d, new Set()); byDesc.get(d)!.add(c); });
    const past = new Map<string, { barcode: string; name: string }>();
    pastSum.forEach(r => { const c = trimCode(r.item); if (c) past.set(c, { barcode: trimCode(r.barcode), name: String(r.item_desc || '').trim() }); });
    pastBuy.forEach(r => { const c = trimCode(r.item); if (c && !past.has(c)) past.set(c, { barcode: '', name: String(r.item_desc || '').trim() }); });
    const now = new Date().toISOString();
    const rows = [...past.entries()].map(([code, x]) => {
      if (x.barcode && byBc.has(x.barcode)) return { year: Number(yr), kind: 'item', code, barcode: x.barcode || null, name: x.name, current_codes: [byBc.get(x.barcode)!], how: 'barcode', built_at: now };
      const d = byDesc.get(dk(x.name));
      if (d && d.size === 1) return { year: Number(yr), kind: 'item', code, barcode: x.barcode || null, name: x.name, current_codes: [...d], how: 'name', built_at: now };
      return { year: Number(yr), kind: 'item', code, barcode: x.barcode || null, name: x.name, current_codes: [] as string[], how: null, built_at: now };
    });
    await upsert(rows);
    return { year: yr, part, items: rows.length, byBarcode: rows.filter(r => r.how === 'barcode').length, byName: rows.filter(r => r.how === 'name').length, left: rows.filter(r => !r.how).length };
  }
  if (part === 'items_search') {
    // the ones left: today's item list searched by their barcode (any of today's barcodes of an item)
    const { data, error } = await db.from('code_map').select('code, barcode').eq('year', Number(yr)).eq('kind', 'item').is('how', null).not('barcode', 'is', null).order('code').range(offset, offset + 299);
    if (error) throw error;
    const list = data || []; let found = 0;
    for (let i = 0; i < list.length; i += 16) {
      await Promise.all(list.slice(i, i + 16).map(async r => {
        let cc: string[] = [];
        try {
          const d = await dash('/items/search?' + new URLSearchParams({ search: String(r.barcode), year: cy, preferred_branch: BRANCH }));
          cc = [...new Set((Array.isArray(d) ? d : []).filter((x: Record<string, unknown>) => trimCode(x.barcode) === r.barcode || ((x.barcodes as unknown[]) || []).map(trimCode).includes(String(r.barcode))).map((x: Record<string, unknown>) => trimCode(x.code)))];
        } catch (e) { console.warn('item search', r.barcode, e); return; }
        if (cc.length) found++;
        await db.from('code_map').update({ current_codes: cc, how: cc.length ? 'barcode (search)' : 'not found', built_at: new Date().toISOString() }).eq('year', Number(yr)).eq('kind', 'item').eq('code', r.code);
      }));
    }
    const { count } = await db.from('code_map').select('code', { count: 'exact', head: true }).eq('year', Number(yr)).eq('kind', 'item').is('how', null).not('barcode', 'is', null);
    return { year: yr, part, searched: list.length, found, left: count ?? null };
  }
  throw new Error('part: suppliers | items | items_search');
}

/* ---------------- last purchase (shared: Audit, credit note, purchase order) ----------------
   The last purchase day (on or before `until`, this year else last year) and that day's purchase lines from
   the item cardex, per document; a paid line + a 100% discount line = a trade deal, real cost = paid / all units. */
async function lastCosts(codes: string[], until?: string): Promise<Record<string, unknown>> {
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
  // until (optional): the last purchase on or before that day (a sell-out's credit note uses its last day)
  const now = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(until || '')) && String(until) < now ? String(until) : now, y = Number(today.slice(0, 4));
  const last: Record<string, string> = {}, lastCode: Record<string, string> = {};
  const byItem = (d: unknown) => (((d as Record<string, unknown>)?.data as Record<string, unknown>)?.branches as Record<string, Record<string, unknown>[]>)?.[BRANCH] || [];
  // a read that failed is never taken for "no purchase" (nor for an older one from last year): it is marked failed
  const unknown = new Set<string>();
  for (const yr of [y, y - 1]) {
    const want = codes.filter(c => !last[c] && !unknown.has(c)); if (!want.length) break;
    try {
      const rows = await yearRows('/items_purchases', { branches: [BRANCH], year: String(yr), from_date: `${yr}-01-01`, to_date: yr === y ? today : `${yr}-12-31`, aggregation: 'Daily', group_by: ['item'], item: want });
      const codeOf = new Map(want.map(c => [key(c), c]));
      rows.forEach(r => { const c = codeOf.get(key(String(r.item ?? ''))); if (c && Number(r.total_quantity || 0) > 0 && String(r.period) > String(last[c] || '')) { last[c] = String(r.period); lastCode[c] = String(r._yrItem || c); } });
    } catch (e) { console.warn('last purchase', yr, e); want.forEach(c => unknown.add(c)); }
  }
  const r2 = (n: number) => Math.round(n * 10000) / 10000;
  const costs: Record<string, unknown> = {};
  const todo = Object.keys(last);
  const readDay = async (c: string) => {
      const day = last[c];
      try {
        const d = await dash(`/item-cardex?${new URLSearchParams({ branch: BRANCH, item_code: lastCode[c] || c, year: day.slice(0, 4), from_date: day, to_date: day })}`) as Record<string, unknown>;
        const rows = (((d.data as Record<string, unknown>)?.rows || []) as Record<string, unknown>[])
          .filter(r => String(r.operation_code) === '15' || /purchase/i.test(String(r.operation_label || '')))
          .filter(r => Number(r.qty_in || 0) > 0);
        // the last PU of that day with a paid line (a day can have several PUs, from several suppliers or currencies:
        // never mixed); a trade deal's paid and free lines are on the same PU, so they stay together
        const all = purchaseDocs(rows), last = [...all].reverse().find(d => Number(d.paidQty) > 0) || all[all.length - 1];
        costs[c] = { date: day, docs: last ? [last] : [], otherDocs: all.filter(d => d !== last).map(d => d.doc) };
      } catch (e) { console.warn('cardex', c, e); }
  };
  for (let i = 0; i < todo.length; i += 12) await Promise.all(todo.slice(i, i + 12).map(readDay));
  // the ones that failed: once more, a few at a time
  const again = todo.filter(c => !(c in costs));
  for (let i = 0; i < again.length; i += 4) await Promise.all(again.slice(i, i + 4).map(readDay));
  todo.forEach(c => { if (!(c in costs)) costs[c] = { date: last[c], docs: [], failed: true }; });
  unknown.forEach(c => { costs[c] = { date: null, docs: [], failed: true }; });
  codes.forEach(c => { if (!(c in costs)) costs[c] = null; });
  return costs;
}

/* ---------------- purchase order data (owner, 2026-10-06) ---------------- */
async function poData(sups: string[], from: string, to: string) {
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' }), y = today.slice(0, 4);
  const items = new Map<string, { code: string; description: string; sold: number; soldValue: number; bought: number }>();
  const rowsOf = (d: unknown) => (((d as Record<string, unknown>)?.data as Record<string, unknown>)?.branches as Record<string, Record<string, unknown>[]>)?.[BRANCH] || [];
  const pieces = from.slice(0, 4) === to.slice(0, 4) ? [[from, to]] : [[from, `${from.slice(0, 4)}-12-31`], [`${to.slice(0, 4)}-01-01`, to]];
  for (const [f, t] of pieces) {
    (await yearRows('/items_sales', { branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Monthly', group_by: ['item'], supplier: sups })).forEach(r => { const c = String(r.item ?? '').trim(); if (!c || c.includes(':')) return; const it = items.get(c) || { code: c, description: String(r.item_desc ?? '').trim(), sold: 0, soldValue: 0, bought: 0 };
      it.sold += Number(r.total_quantity || 0); it.soldValue += Number(r.total_sales || 0); items.set(c, it); });
  }
  try {   // items bought this year that did not sell in the period still belong to the supplier's list
    const d = await dash('/items_purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      branches: [BRANCH], year: y, from_date: `${y}-01-01`, to_date: today, aggregation: 'Monthly', group_by: ['item'], supplier: sups }) });
    rowsOf(d).forEach(r => { const c = String(r.item ?? '').trim(); if (!c) return; const it = items.get(c) || { code: c, description: String(r.item_desc ?? '').trim(), sold: 0, soldValue: 0, bought: 0 };
      it.bought += Number(r.total_quantity || 0); items.set(c, it); });
  } catch (e) { console.warn('po bought', e); }
  const list = [...items.values()].sort((a, b) => b.sold - a.sold || b.bought - a.bought).slice(0, 120);
  const info: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async it => {
      try {
        const d = await dash(`/item-price-checker?${new URLSearchParams({ search: it.code, year: year(), branches: BRANCH })}`) as Record<string, unknown>;
        const hit = (Object.values(((d.branches as Record<string, Record<string, unknown[]>>) || {})[BRANCH] || {}).flat() as Record<string, unknown>[]).find(r => key(String(r.ItemCode ?? '')) === key(it.code));
        if (hit) info[it.code] = { barcode: String(hit.Barcode ?? '').trim(), pack: hit.Pack ?? null, stock: hit.AvailableQuantity ?? null, price: hit.Price ?? null, salePrice: unitSale(hit),
          description: String(hit.Description ?? '').trim(), group: String(hit.Group ?? '').trim(), subgroup: String(hit['Sub-Group'] ?? '').trim() };
      } catch (e) { console.warn('po info', it.code, e); }
    }));
  }
  const costs = await lastCosts(list.map(i => i.code));
  // units sold since each item's last purchase (owner, 2026-10-06): the daily sales of the supplier from the
  // oldest last purchase (a year back at most), each item counted from its own last purchase day
  const lastOf = (c: string) => String(((costs[c] as Record<string, unknown>) || {}).date || '');
  const yearAgo = new Date(Date.now() - 365 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
  const starts = list.map(i => lastOf(i.code)).filter(Boolean).map(d => d < yearAgo ? yearAgo : d).sort();
  const since: Record<string, number> = {};
  if (starts.length) {
    const s0 = starts[0], parts = s0.slice(0, 4) === y ? [[s0, today]] : [[s0, `${s0.slice(0, 4)}-12-31`], [`${y}-01-01`, today]];
    const codeOf = new Map(list.map(i => [key(i.code), i.code]));
    try {
      for (const [f, t] of parts) {
        (await yearRows('/items_sales', { branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Daily', group_by: ['item'], supplier: sups })).forEach(r => {
          const c = codeOf.get(key(String(r.item ?? ''))); if (!c) return;
          const lp = lastOf(c), p = String(r.period || '').slice(0, 10);
          if (lp && p >= (lp < yearAgo ? yearAgo : lp)) since[c] = (since[c] || 0) + Number(r.total_quantity || 0);
        });
      }
    } catch (e) { console.warn('po since', e); }
  }
  const days = Math.round((new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 864e5) + 1;
  return { from, to, days, items: list.map(it => ({ ...it, ...(info[it.code] || {}), description: (info[it.code]?.description as string) || it.description, last: costs[it.code] ?? null,
    soldSinceLast: lastOf(it.code) ? Math.round((since[it.code] || 0) * 1000) / 1000 : null, sinceFrom: lastOf(it.code) ? (lastOf(it.code) < yearAgo ? yearAgo : lastOf(it.code)) : null })), today };
}

/* ---------------- Performance & Pricing (owner, 2026-10-06) ---------------- */
const isDay = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const beirutToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
const plusDays = (d: string, k: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const byYear = (from: string, to: string) => { const out: string[][] = []; for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) out.push([String(y) === from.slice(0, 4) ? from : `${y}-01-01`, String(y) === to.slice(0, 4) ? to : `${y}-12-31`]); return out; };
const branchRows = (d: unknown) => (((d as Record<string, unknown>)?.data as Record<string, unknown>)?.branches as Record<string, Record<string, unknown>[]>)?.[BRANCH] || [];
async function report(kind: 'sales' | 'purchases', from: string, to: string, extra: Record<string, unknown>) {
  const rows: Record<string, unknown>[] = [];
  for (const [f, t] of byYear(from, to)) {
    rows.push(...await yearRows(kind === 'sales' ? '/items_sales' : '/items_purchases', { branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Monthly', ...extra }));
  }
  return rows;
}
// every supplier: purchases vs sales in the period
async function perfSuppliers(from: string, to: string) {
  const [p, sl] = await Promise.all([report('purchases', from, to, { group_by: ['supplier'] }), report('sales', from, to, { group_by: ['supplier'] })]);
  const m = new Map<string, { code: string; name: string; bought: number; boughtQty: number; sold: number; soldQty: number }>();
  const get = (r: Record<string, unknown>) => { const c = String(r.supplier ?? '').trim() || '?'; let x = m.get(c); if (!x) { x = { code: c, name: String(r.supplier_desc ?? '').trim() || 'No supplier', bought: 0, boughtQty: 0, sold: 0, soldQty: 0 }; m.set(c, x); } return x; };
  p.forEach(r => { const x = get(r); x.bought += Number(r.total_purchases || 0); x.boughtQty += Number(r.total_quantity || 0); });
  sl.forEach(r => { const x = get(r); x.sold += Number(r.total_sales || 0); x.soldQty += Number(r.total_quantity || 0); });
  return { from, to, suppliers: [...m.values()] };
}
// one supplier: per item and per month
async function perfSupplier(sup: string, from: string, to: string) {
  const [p, sl] = await Promise.all([report('purchases', from, to, { group_by: ['item'], supplier: [sup] }), report('sales', from, to, { group_by: ['item'], supplier: [sup] })]);
  const items = new Map<string, { code: string; description: string; bought: number; boughtQty: number; sold: number; soldQty: number }>();
  const months: Record<string, { bought: number; sold: number }> = {};
  const get = (r: Record<string, unknown>) => { const c = String(r.item ?? '').trim(); let x = items.get(c); if (!x) { x = { code: c, description: String(r.item_desc ?? '').trim(), bought: 0, boughtQty: 0, sold: 0, soldQty: 0 }; items.set(c, x); } return x; };
  const mon = (r: Record<string, unknown>) => { const k = String(r.period || '').slice(0, 7); return months[k] = months[k] || { bought: 0, sold: 0 }; };
  p.forEach(r => { const x = get(r), v = Number(r.total_purchases || 0); x.bought += v; x.boughtQty += Number(r.total_quantity || 0); mon(r).bought += v; });
  sl.forEach(r => { const x = get(r), v = Number(r.total_sales || 0); x.sold += v; x.soldQty += Number(r.total_quantity || 0); mon(r).sold += v; });
  // profit (owner, 2026-10-06): sales - units sold x unit cost, item by item. The unit cost:
  //   bought in the period: the period's purchases / units (free units included, so trade deals lower it);
  //   else: its last purchase day in the 12 months before (that day's purchases / units), from one daily report;
  //   no purchase in those 12 months: no cost (an old one would mislead), counted apart.
  // All in $ as the system's reports give them (VAT included on both sides, like the sales).
  const list = [...items.values()] as (Record<string, unknown> & { code: string; bought: number; boughtQty: number; sold: number; soldQty: number })[];
  list.forEach(x => { if (x.boughtQty > 0 && x.bought > 0) { x.unitCost = x.bought / x.boughtQty; x.costFrom = 'period'; } });
  const need = list.filter(x => x.soldQty > 0 && x.unitCost === undefined);
  if (need.length) {
    const key = (c: string) => c.replace(/^0+(?=d)/, '').toUpperCase();
    const byKey = new Map(need.map(x => [key(x.code), x]));
    const lastDay: Record<string, { day: string; qty: number; value: number }> = {};
    try {
      const rows = await report('purchases', plusDays(from, -365), plusDays(from, -1), { aggregation: 'Daily', group_by: ['item'], supplier: [sup] });
      rows.forEach(r => { const k = key(String(r.item ?? '')); if (!byKey.has(k)) return; const p = String(r.period || '').slice(0, 10), q = Number(r.total_quantity || 0), v = Number(r.total_purchases || 0);
        if (q > 0 && v > 0 && (!lastDay[k] || p > lastDay[k].day)) lastDay[k] = { day: p, qty: q, value: v }; });
      need.forEach(x => { const l = lastDay[key(x.code)]; if (l) { x.unitCost = l.value / l.qty; x.costFrom = 'last'; x.costDate = l.day; } else x.costFrom = 'none'; });
    } catch (e) { console.warn('perf last cost', e); need.forEach(x => { x.costFrom = 'failed'; }); }
  }
  list.forEach(x => { if (typeof x.unitCost === 'number' && x.soldQty > 0) { x.cogs = x.soldQty * (x.unitCost as number); x.profit = x.sold - (x.cogs as number); } });
  return { from, to, supplier: sup, items: list, months };
}
// the purchase lines of a cardex, per document; a paid line + a 100% discount line = a trade deal
function purchaseDocs(rows: Record<string, unknown>[]) {
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  const docs = new Map<string, Record<string, unknown>[]>();
  rows.forEach(r => { const k = String(r.document_no || r.document_number || '?'); if (!docs.has(k)) docs.set(k, []); docs.get(k)!.push(r); });
  return [...docs.entries()].map(([doc, ls]) => {
    const lines = ls.map(r => {
      const up = Number(r.unit_price || 0), net = Math.abs(Number(r.net_unit_price || 0)) < 0.005 ? 0 : Number(r.net_unit_price || 0);
      const back = isReturn(r), q = back ? -Math.abs(Number(r.qty_out || 0)) : Number(r.qty_in || 0);
      return { qty: r4(q), unit: r4(up), net: r4(net), total: r4(back ? -Math.abs(Number(r.line_total || 0)) : Number(r.line_total || 0)), discountPct: up > 0 ? Math.round((1 - net / up) * 100) : 0, free: net === 0 };
    });
    const paidQty = lines.filter(l => !l.free).reduce((t, l) => t + l.qty, 0), freeQty = lines.filter(l => l.free).reduce((t, l) => t + l.qty, 0);
    const paid = lines.reduce((t, l) => t + l.total, 0);
    return { doc, kind: isReturn(ls[0]) ? 'return' : 'purchase', supplier: String(ls[0].details || ''), currency: String(ls[0].currency || '$'), lines, paidQty: r4(paidQty), freeQty: r4(freeQty), paid: r4(paid),
      tradeDeal: paidQty > 0 && freeQty > 0, realCost: paidQty + freeQty !== 0 ? r4(paid / (paidQty + freeQty)) : null };
  });
}
// a return to the supplier (PT): operation 20, the quantity goes out
const isReturn = (r: Record<string, unknown>) => (String(r.operation_code) === '20' || /return to supplier/i.test(String(r.operation_label || ''))) && Number(r.qty_out || 0) !== 0;
// the supplier on a cardex line ("G.VINCENTI &SONS S.A.L 132002") and the system's supplier name, compared
const supKey = (s: unknown) => String(s || '').toUpperCase().replace(/\s+\d+\s*$/, '').replace(/[^A-Z0-9\u0600-\u06FF]/g, '');
const supName = (s: unknown) => String(s || '').replace(/\s+\d+\s*$/, '').trim();
const isPurchase = (r: Record<string, unknown>) => (String(r.operation_code) === '15' || /purchase/i.test(String(r.operation_label || ''))) && Number(r.qty_in || 0) > 0;
// the suppliers that delivered on a day
async function pricingDay(day: string) {
  const d = await dash('/items_purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    branches: [BRANCH], year: day.slice(0, 4), from_date: day, to_date: day, aggregation: 'Daily', group_by: ['item', 'supplier'] }) });
  const m = new Map<string, { code: string; name: string; items: number; qty: number; value: number }>();
  branchRows(d).forEach(r => { const c = String(r.supplier ?? '').trim() || '?'; const x = m.get(c) || { code: c, name: String(r.supplier_desc ?? '').trim() || 'No supplier', items: 0, qty: 0, value: 0 };
    x.items++; x.qty += Number(r.total_quantity || 0); x.value += Number(r.total_purchases || 0); m.set(c, x); });
  return { day, suppliers: [...m.values()].sort((a, b) => b.value - a.value) };
}
// one supplier's deliveries of a day, line by line: the PU, the prices, the previous purchase, the stock we had
// the returns to suppliers (PT) between two days: every returned line, with the last purchase price before it
async function returnsRange(from: string, to: string, withPrev = false) {
  const key = (c: string) => c.replace(/^0+(?=d)/, '').toUpperCase();
  const cand = new Map<string, { code: string; description: string; supplier: string; supplierName: string }>(), pairs = new Set<string>();
  for (const [f, t] of byYear(from, to)) {
    const d = await dash('/items_purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Daily', group_by: ['item', 'supplier'] }) });
    branchRows(d).forEach(r => { const c = String(r.item ?? '').trim(); if (!c || Number(r.total_quantity || 0) >= 0) return;
      pairs.add(`${c}|${String(r.period || '').slice(0, 10)}`);
      if (!cand.has(c)) cand.set(c, { code: c, description: String(r.item_desc ?? '').trim(), supplier: String(r.supplier ?? '').trim(), supplierName: String(r.supplier_desc ?? '').trim() }); });
  }
  const todo = [...pairs].slice(0, 250).map(p => p.split('|'));
  const lines: Record<string, unknown>[] = [];
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async ([c, dd]) => {
      try {
        const cx = await dash(`/item-cardex?${new URLSearchParams({ branch: BRANCH, item_code: c, year: dd.slice(0, 4), from_date: dd, to_date: dd })}`) as Record<string, unknown>;
        const rs = ((((cx.data as Record<string, unknown>)?.rows || []) as Record<string, unknown>[])).filter(isReturn);
        if (rs.length) purchaseDocs(rs).forEach(doc => lines.push({ ...doc, ...cand.get(c), supplierName: supName(doc.supplier) || cand.get(c)?.supplierName, day: dd, barcode: String(rs[0].barcode ?? '').trim(),
          stockAfter: Math.round(Number(rs[rs.length - 1].running_balance ?? 0) * 1000) / 1000 }));
      } catch (e) { console.warn('returns cardex', c, e); }
    }));
  }
  // the last purchase before each return day (on request: it takes longer)
  const days = withPrev ? [...new Set(lines.map(l => String(l.day)))] : [];
  for (const dd of days) {
    const cs = [...new Set(lines.filter(l => l.day === dd).map(l => String(l.code)))];
    try {
      const cur = dd.slice(0, 4) === year() ? Object.fromEntries(cs.map(c => [c, c])) : await fromYear('item', cs, dd.slice(0, 4));
      const lc = await lastCosts([...new Set(Object.values(cur))], plusDays(dd, -1));
      lines.filter(l => l.day === dd).forEach(l => { const x = lc[cur[String(l.code)]]; if (x) l.prev = x; });
    }
    catch (e) { console.warn('returns prev', dd, e); }
  }
  lines.sort((a, b) => String(b.day).localeCompare(String(a.day)) || String(a.doc).localeCompare(String(b.doc)));
  return { from, to, lines, truncated: pairs.size > todo.length };
}
// in two parts so the app can show the PU quickly (owner, 2026-10-06):
//   part 'lines': the items and that day's cardex (the PU lines, the prices, the stock we had)
//   part 'more':  for the given codes: sales of the 90 days before, the price now, the previous purchase
//   no part:      both
// one document as the dashboard shows it: PU0010852 -> type PU, number 0010852; a return (PT) is operation 20
async function viewDoc(code: string, ret: boolean, yr = year()) {
  const m = /^([A-Z]+)(\d+)$/.exec(code); if (!m) return null;
  const d = await dash('/operations/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    year: yr, branch: BRANCH, document_type: m[1], document_number: m[2], operation_code: ret ? '20' : '15' }) }) as Record<string, unknown>;
  const v = d?.data as Record<string, unknown> | undefined;
  if (!v || !Array.isArray(v.lines)) return null;
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase(), r4 = (n: number) => Math.round(n * 10000) / 10000;
  const items: Record<string, { qty: number; vat: number; withVat: number; line: number; ls: { qty: number; unit: number; net: number; total: number; disc: number }[] }> = {};
  (v.lines as Record<string, unknown>[]).forEach((l, i) => { const k = key(String(l.item_code ?? '').trim()); const ln = Number(l.line_number) || i + 1;
    const x = items[k] || { qty: 0, vat: 0, withVat: 0, line: ln, ls: [] }; if (ln < x.line) x.line = ln;
    x.ls.push({ qty: Number(l.quantity || 0), unit: Number(l.unit_price || 0), net: Number(l.net_unit_price || 0), total: Number(l.total_with_vat || 0), disc: Number(l.unit_discount_percent || 0) });
    x.qty = r4(x.qty + Number(l.quantity || 0)); x.vat = r4(x.vat + Number(l.vat_amount || 0)); x.withVat = r4(x.withVat + Number(l.total_with_vat || 0)); items[k] = x; });
  return { doc: String(v.document_code || code), date: String(v.document_date || ''), partner: String(v.partner_name || ''), currency: String(v.currency || ''),
    withVat: Number(v.total_with_vat || 0), withoutVat: Number(v.total_without_vat || 0), vat: Number(v.vat_amount || 0), discountPct: Number(v.total_percent_discount || 0),
    lines: (v.lines as unknown[]).length, items };
}
async function pricingSupplier(day: string, sup: string, part = '', only: string[] = [], name = '', docsIn: { doc: string; ret: boolean }[] = []) {
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
  const POOL = 16;
  const pool = async (list: string[], fn: (c: string) => Promise<void>) => { for (let i = 0; i < list.length; i += POOL) await Promise.all(list.slice(i, i + POOL).map(fn)); };
  const out: Record<string, Record<string, unknown>> = {};
  const docInfo: Record<string, unknown> = {};
  let codes: string[], truncated = false;
  if (part === 'more') {
    codes = only.map(String).filter(Boolean).slice(0, 150);
    codes.forEach(c => { out[c] = { code: c }; });
  } else {
    const d = await dash('/items_purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      branches: [BRANCH], year: day.slice(0, 4), from_date: day, to_date: day, aggregation: 'Daily', group_by: ['item'], supplier: [sup] }) });
    const items = new Map<string, string>();
    branchRows(d).forEach(r => { const c = String(r.item ?? '').trim(); if (c) items.set(c, String(r.item_desc ?? '').trim()); });
    codes = [...items.keys()].slice(0, 150); truncated = items.size > codes.length;
    codes.forEach(c => { out[c] = { code: c, description: items.get(c) }; });
  }
  const lines = () => pool(codes, async c => {
    const it = out[c];
    try {
      const cx = await dash(`/item-cardex?${new URLSearchParams({ branch: BRANCH, item_code: c, year: day.slice(0, 4), from_date: day, to_date: day })}`) as Record<string, unknown>;
      const all = ((((cx.data as Record<string, unknown>)?.rows || []) as Record<string, unknown>[])).filter(r => isPurchase(r) || isReturn(r));
      // this supplier's documents only (when its name is known and found on the lines)
      const mine = name ? all.filter(r => supKey(r.details) === supKey(name)) : all;
      const today = mine.length ? mine : all;
      it.otherSuppliers = mine.length ? [...new Set(all.filter(r => !mine.includes(r)).map(r => supName(r.details)))] : [];
      it.docs = purchaseDocs(today);
      it.barcode = String(today[0]?.barcode ?? '').trim();
      it.stockBefore = today[0] ? Math.round((Number(today[0].running_balance ?? 0) - (isReturn(today[0]) ? -Math.abs(Number(today[0].qty_out || 0)) : Number(today[0].qty_in || 0))) * 1000) / 1000 : null;
    } catch (e) { console.warn('pricing cardex', c, e); it.docs = []; it.cardexFailed = true; }
  });
  const more = async () => {
    const salesDays = 90, sold: Record<string, number> = {};
    // a day of a past year: its codes are that year's; today's codes for the lookups (migration 069)
    const dy = day.slice(0, 4), curOf: Record<string, string> = dy === year() ? Object.fromEntries(codes.map(c => [c, c])) : await fromYear('item', codes, dy);
    const dayOf = new Map(codes.filter(c => curOf[c]).map(c => [key(curOf[c]), c])), curCodes = codes.map(c => curOf[c]).filter(Boolean);
    const prevP = (curCodes.length ? lastCosts(curCodes, plusDays(day, -1)) : Promise.resolve({} as Record<string, unknown>))
      .then(lc => Object.fromEntries(codes.filter(c => curOf[c]).map(c => [c, lc[curOf[c]]])) as Record<string, unknown>);
    const salesP = (curCodes.length ? report('sales', plusDays(day, -90), plusDays(day, -1), { group_by: ['item'], item: curCodes }) : Promise.resolve([] as Record<string, unknown>[]))
      .then(rows => rows.forEach(r => { const c = dayOf.get(key(String(r.item ?? ''))); if (c) sold[c] = (sold[c] || 0) + Number(r.total_quantity || 0); }))
      .catch(e => console.warn('pricing sales', e));
    await pool(codes, async c => {
      const it = out[c];
      try {
        const cc = curOf[c]; if (!cc) { it.priceFailed = true; return; }
        const pc = await dash(`/item-price-checker?${new URLSearchParams({ search: cc, year: year(), branches: BRANCH })}`) as Record<string, unknown>;
        const hit = (Object.values(((pc.branches as Record<string, Record<string, unknown[]>>) || {})[BRANCH] || {}).flat() as Record<string, unknown>[]).find(r => key(String(r.ItemCode ?? '')) === key(cc));
        if (hit) { if (cc !== c) it.currentCode = cc; it.salePrice = unitSale(hit); it.saleCurrency = String(hit.CurrencyCode) === '01' ? 'LBP' : '$'; it.pack = hit.Pack ?? null; it.stockNow = hit.AvailableQuantity ?? null; it.pcBarcode = String(hit.Barcode ?? '').trim(); }
        else it.priceFailed = true;
      } catch (e) { console.warn('pricing price', c, e); it.priceFailed = true; }
    });
    await readDocs(docsIn);
    await salesP;
    const prev = await prevP;
    codes.forEach(c => { const it = out[c]; it.salesDays = salesDays; it.soldBefore = Math.round((sold[c] || 0) * 1000) / 1000; if (prev[c]) it.prev = prev[c]; });
  };
  // the PU documents themselves (one request each): the line order, VAT per item, the totals with / without VAT, the discount
  async function readDocs(list: { doc: string; ret: boolean }[]) {
    await Promise.all(list.slice(0, 40).map(async x => {
      try { const v = await viewDoc(String(x.doc), !!x.ret, day.slice(0, 4)); docInfo[String(x.doc)] = v || { failed: true }; }
      catch (e) { console.warn('pricing viewer', x.doc, e); docInfo[String(x.doc)] = { failed: true }; }
    }));
  }
  const docsOfLines = () => [...new Map(codes.flatMap(c => ((out[c].docs as Record<string, unknown>[]) || []).map(d => [String(d.doc), { doc: String(d.doc), ret: d.kind === 'return' }]))).values()];
  // a line is never lost: an item whose cardex failed is read again; still failing, its line comes from the PU itself
  // (the document in the system: exact prices and quantities; only the stock we had is then unknown)
  const recover = async () => {
    const failed = codes.filter(c => out[c].cardexFailed);
    for (let i = 0; i < failed.length; i += 4) await Promise.all(failed.slice(i, i + 4).map(async c => {
      const it = out[c];
      try {
        const cx = await dash(`/item-cardex?${new URLSearchParams({ branch: BRANCH, item_code: c, year: day.slice(0, 4), from_date: day, to_date: day })}`) as Record<string, unknown>;
        const all = ((((cx.data as Record<string, unknown>)?.rows || []) as Record<string, unknown>[])).filter(r => isPurchase(r) || isReturn(r));
        const mine = name ? all.filter(r => supKey(r.details) === supKey(name)) : all, today = mine.length ? mine : all;
        it.otherSuppliers = mine.length ? [...new Set(all.filter(r => !mine.includes(r)).map(r => supName(r.details)))] : [];
        it.docs = purchaseDocs(today); it.barcode = String(today[0]?.barcode ?? '').trim();
        it.stockBefore = today[0] ? Math.round((Number(today[0].running_balance ?? 0) - (isReturn(today[0]) ? -Math.abs(Number(today[0].qty_out || 0)) : Number(today[0].qty_in || 0))) * 1000) / 1000 : null;
        delete it.cardexFailed;
      } catch (e) { console.warn('pricing cardex again', c, e); }
    }));
  };
  const fromDocs = () => {
    const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase(), r4 = (x: number) => Math.round(x * 10000) / 10000;
    codes.filter(c => out[c].cardexFailed).forEach(c => {
      const it = out[c], docs: Record<string, unknown>[] = [];
      Object.values(docInfo).forEach(v0 => { const v = v0 as Record<string, unknown>; const x = (v.items as Record<string, { ls: { qty: number; unit: number; net: number; total: number; disc: number }[] }> | undefined)?.[key(c)];
        if (!x || v.failed) return;
        const ret = /^PT/.test(String(v.doc)), sign = ret ? -1 : 1;
        const lines = x.ls.map(l => { const net = Math.abs(l.net) < 0.005 ? 0 : l.net; return { qty: r4(sign * l.qty), unit: r4(l.unit), net: r4(net), total: r4(sign * l.total),
          discountPct: Math.round(l.disc) || (l.unit > 0 ? Math.round((1 - net / l.unit) * 100) : 0), free: net === 0 }; });
        const paidQty = lines.filter(l => !l.free).reduce((t, l) => t + l.qty, 0), freeQty = lines.filter(l => l.free).reduce((t, l) => t + l.qty, 0), paid = lines.reduce((t, l) => t + l.total, 0);
        docs.push({ doc: String(v.doc), kind: ret ? 'return' : 'purchase', supplier: String(v.partner || ''), currency: String(v.currency || ''), lines, paidQty: r4(paidQty), freeQty: r4(freeQty), paid: r4(paid),
          tradeDeal: paidQty > 0 && freeQty > 0, realCost: paidQty + freeQty !== 0 ? r4(paid / (paidQty + freeQty)) : null, fromDocument: true });
      });
      if (docs.length) { it.docs = docs; it.stockBefore = null; it.fromDocument = true; }
    });
  };
  if (part === 'lines') { await lines(); await recover(); await readDocs(docsOfLines()); fromDocs(); }
  else if (part === 'more') await more();
  else { await Promise.all([lines(), more()]); await recover(); await readDocs(docsOfLines()); fromDocs(); }
  codes.forEach(c => { const it = out[c]; if (part !== 'more' && !it.barcode && it.pcBarcode) it.barcode = it.pcBarcode; if (part !== 'more') delete it.pcBarcode; });
  return { day, supplier: sup, part: part || 'all', items: codes.map(c => out[c]), docs: docInfo, truncated };
}

/* ---------------- new sale prices waiting for the system (migration 067) ----------------
   The pending ones: the system's sale price now (price checker, the unit price); equal to the new price -> synced. */
async function priceChangesSync(limit = 80) {
  const key = (c: string) => c.replace(/^0+(?=d)/, '').toUpperCase();
  const { data: rows, error } = await db.from('price_changes').select('id, code, new_price').eq('status', 'pending').order('checked_at', { ascending: true, nullsFirst: true }).limit(limit);
  if (error) throw error;
  const now = new Date().toISOString(); let synced = 0, checked = 0;
  const list = rows || [];
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async r => {
      try {
        const pc = await dash(`/item-price-checker?${new URLSearchParams({ search: r.code, year: year(), branches: BRANCH })}`) as Record<string, unknown>;
        const hit = (Object.values(((pc.branches as Record<string, Record<string, unknown[]>>) || {})[BRANCH] || {}).flat() as Record<string, unknown>[]).find(x => key(String(x.ItemCode ?? '')) === key(r.code));
        if (!hit) return;
        const sp = unitSale(hit), np = Number(r.new_price);
        const same = sp !== null && Math.abs(Number(sp) - np) <= Math.max(0.005, Math.abs(np) * 0.0001);
        await db.from('price_changes').update(same ? { system_price: sp, checked_at: now, status: 'synced', synced_at: now } : { system_price: sp, checked_at: now }).eq('id', r.id).eq('status', 'pending');
        checked++; if (same) synced++;
      } catch (e) { console.warn('price change', r.code, e); }
    }));
  }
  return { pending: list.length, checked, synced };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  // The nightly price watch (migration 064), from pg_cron (x-cron-secret) or the server key.
  if (body.action === 'price_watch') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await priceWatch(Number(body.limit) || 150)); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // The stock watch (migration 066), from pg_cron or the server key.
  if (body.action === 'stock_watch') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { const sw = await stockWatch(body.vendor ? String(body.vendor) : undefined); let pc = null; try { pc = await priceChangesSync(60); } catch (e) { console.warn('price changes', e); } return json({ ...sw, priceChanges: pc }); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // who is asking: a signed-in, active app user (or the server itself, for "status")
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const apikey = req.headers.get('apikey') || '';
  const isServer = (!!bearer && serverKeys().includes(bearer)) || (!!apikey && serverKeys().includes(apikey));
  let role = '';
  if (!isServer) {
    const { data: u } = await db.auth.getUser(bearer);
    if (!u?.user) return json({ error: 'Sign in first.' }, 401);
    const { data: prof } = await db.from('profiles').select('role, active').eq('id', u.user.id).maybeSingle();
    if (!prof?.active) return json({ error: 'Not allowed.' }, 403);
    role = prof.role || '';
  }

  try {
    // Check one watched vendor's stock now (admin, the Vendors page's Check now).
    if (body.action === 'stock_check_now') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      return json(await stockWatch(String(body.vendor || '')));
    }
    // Prepare the codes of a past year (migration 069): part suppliers | items | items_search (offset)
    if (body.action === 'code_map_build') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      return json(await buildCodeMap(String(body.year || ''), String(body.part || ''), Number(body.offset) || 0));
    }
    if (body.action === 'status') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      // a real, light read (logs in only when needed): proves the login and the data both work
      if (body.fresh) token = null;
      const t0 = Date.now();
      const sample = await search(String(body.code || '128420'));
      return json({ ok: true, user: Deno.env.get('LV_DASH_USER'), expires_at: new Date(tokenExp).toISOString(), ms: Date.now() - t0,
        sample: sample[0] ? { code: sample[0].code, description: sample[0].description, stock: sample[0].available_quantity ?? null } : null });
    }
    // Server key only (maintenance): one read-only report, as the dashboard answers it, to map its fields.
    if (body.action === 'probe') {
      if (!isServer) return json({ error: 'Not allowed.' }, 403);
      const path = String(body.path || '');
      const READ = /^\/(item-price-checker|item-cardex|items\/search|items\/filter-options\/[a-z]+|items_sales(\/grid|\/summary)?|items_purchases(\/grid)?|operations\/viewer|wms\/documents(\/\d+)?|wms\/purchase-orders)$/;
      if (!READ.test(path)) return json({ error: 'Not a read-only report.' }, 400);
      if (body.post) return json(await dash(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body.post) }));
      return json(await dash(`${path}?${new URLSearchParams((body.query || {}) as Record<string, string>)}`));
    }
    // The Promotions page's item details, live (replaces the catalog file): up to 100 codes.
    //   price check (one per code): description, barcode, pack, supplier, section, group, brand, price now,
    //   normal price, on promotion, stock; sales this year (one report); last purchase date (one report).
    if (body.action === 'items_info') {
      const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean))].slice(0, 100);
      const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
      const y = year(), today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
      const out: Record<string, Record<string, unknown>> = {};
      for (let i = 0; i < codes.length; i += 6) {
        await Promise.all(codes.slice(i, i + 6).map(async c => {
          try {
            const d = await dash(`/item-price-checker?${new URLSearchParams({ search: c, year: y, branches: BRANCH })}`) as Record<string, unknown>;
            const br = ((d.branches as Record<string, Record<string, unknown[]>>) || {})[BRANCH] || {};
            const rows = (Object.values(br).flat() as Record<string, unknown>[]);
            const hit = rows.find(r => key(String(r.ItemCode ?? '')) === key(c));
            if (!hit) return;
            const t = (v: unknown) => String(v ?? '').trim();
            out[c] = { code: t(hit.ItemCode), description: t(hit.Description), size: t(hit.Description4), barcodes: hit.Barcode ? [t(hit.Barcode)] : [],
              pack: hit.Pack ?? null, supplier: t(hit.Supplier), section: t(hit.Section), group: t(hit.Group), brand: t(hit.Brand),
              price: hit.Price ?? null, salePrice: unitSale(hit), promoted: !!Number(hit.isPromoted || 0), stock: hit.AvailableQuantity ?? null,
              outYtd: null, lastPurchase: null };
          } catch (e) { console.warn('price check', c, e); }
        }));
      }
      const found = Object.keys(out);
      if (found.length) {
        const base = { branches: [BRANCH], year: y, from_date: `${y}-01-01`, to_date: today, group_by: ['item'], item: found.map(c => String(out[c].code)) };
        const byItem = (d: unknown) => (((d as Record<string, unknown>)?.data as Record<string, unknown>)?.branches as Record<string, Record<string, unknown>[]>)?.[BRANCH] || [];
        const codeOf = new Map(found.map(c => [key(String(out[c].code)), c]));
        try {
          const s = await dash('/items_sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, aggregation: 'Monthly' }) });
          byItem(s).forEach(r => { const c = codeOf.get(key(String(r.item ?? ''))); if (c) out[c].outYtd = Number(out[c].outYtd || 0) + Number(r.total_quantity || 0); });
          found.forEach(c => { if (out[c].outYtd === null) out[c].outYtd = 0; });
        } catch (e) { console.warn('sales', e); }
        try {
          const p = await dash('/items_purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, aggregation: 'Daily' }) });
          byItem(p).forEach(r => { const c = codeOf.get(key(String(r.item ?? ''))); if (c && Number(r.total_quantity || 0) > 0 && String(r.period) > String(out[c].lastPurchase || '')) out[c].lastPurchase = String(r.period); });
        } catch (e) { console.warn('purchases', e); }
      }
      return json({ items: out });
    }
    // Last purchase cost (owner, 2026-10-06), up to 60 codes: the day of the last purchase (this year, else last
    // year), then that day's purchase lines from the item cardex, grouped by document (the PU / PC number).
    // In one document, a paid line + a line at 100% discount = a trade deal (e.g. 30 + 6 free):
    // both lines are given, and the real cost = what was paid / all the units received.
    if (body.action === 'last_cost') {
      const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean))].slice(0, 60);
      return json({ costs: await lastCosts(codes, body.until ? String(body.until) : undefined) });
    }
    // A purchase order for a supplier (owner, 2026-10-06): its items (sold in the period, or bought this year),
    // code, description, barcode, pack, stock now, units sold in the period, the last purchase (date, quantity with
    // its free units, price, trade deal). Up to 120 items.
    if (body.action === 'po_data') {
      const sups = (Array.isArray(body.suppliers) ? body.suppliers : []).map(String).filter(Boolean).slice(0, 10);
      const ok = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
      if (!sups.length || !ok(body.from) || !ok(body.to) || String(body.from) > String(body.to)) return json({ error: 'Choose the supplier and the period.' }, 400);
      return json(await poData(sups, String(body.from), String(body.to)));
    }
    // A promotion's results (owner, 2026-10-06): units and sales per item over its dates, and over the same number
    // of days just before (the baseline). Up to 300 codes; periods within one year each.
    // Performance (supplier sales vs purchases) and Pricing (a day's purchases checked), owner 2026-10-06: vendors.manage
    if (body.action === 'price_changes_sync') {
      if (!isServer && role !== 'admin') {
        const asUser = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false, autoRefreshToken: false } });
        const { data: okPerm } = await asUser.rpc('has_perm', { p_perms: ['vendors.manage', 'floorcheck.do', 'floorcheck.manage'] });
        if (!okPerm) return json({ error: 'Not allowed.' }, 403);
      }
      return json(await priceChangesSync(120));
    }
    if (['perf_suppliers', 'perf_supplier', 'pricing_day', 'pricing_supplier', 'returns_range', 'pu_find'].includes(String(body.action))) {
      if (!isServer && role !== 'admin') {
        const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
        const asUser = createClient(SUPABASE_URL, anon, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false, autoRefreshToken: false } });
        const { data: okPerm } = await asUser.rpc('has_perm', { p_perms: ['vendors.manage'] });
        if (!okPerm) return json({ error: 'Not allowed.' }, 403);
      }
      const from = String(body.from || ''), to = String(body.to || ''), day = String(body.day || '');
      if (body.action === 'perf_suppliers' || body.action === 'perf_supplier') {
        if (!isDay(from) || !isDay(to) || from > to || Number(to.slice(0, 4)) - Number(from.slice(0, 4)) > 1) return json({ error: 'Choose dates within two years.' }, 400);
        if (body.action === 'perf_suppliers') return json(await perfSuppliers(from, to));
        if (!body.supplier) return json({ error: 'Choose a supplier.' }, 400);
        return json(await perfSupplier(String(body.supplier), from, to));
      }
      // a PU by its number (PU0010852, pu 10852, 10852, PC0001899, PT0001005…): its day and supplier, this year or last
      if (body.action === 'pu_find') {
        const q = String(body.q || '').toUpperCase().replace(/\s+/g, '');
        const m = /^([A-Z]{2})?0*(\d{1,7})$/.exec(q);
        if (!m) return json({ error: 'Type a PU number, like PU0010852 or 10852.' }, 400);
        const type = m[1] || 'PU', num = m[2].padStart(7, '0'), y = Number(beirutToday().slice(0, 4));
        for (const yr of [y, y - 1]) {
          for (const ret of type === 'PT' ? [true] : [false]) {
            try {
              const v = await viewDoc(type + num, ret, String(yr));
              if (v && v.date) return json({ found: true, doc: v.doc, day: v.date.slice(0, 10), partner: v.partner, currency: v.currency, withVat: v.withVat, lines: v.lines, ret });
            } catch (e) { console.warn('pu_find', type + num, yr, e); }
          }
        }
        return json({ found: false, doc: type + num });
      }
      if (body.action === 'returns_range') {
        if (!isDay(from) || !isDay(to) || from > to || (new Date(to).getTime() - new Date(from).getTime()) / 864e5 > 62) return json({ error: 'Choose up to 2 months.' }, 400);
        return json(await returnsRange(from, to, !!body.withPrev));
      }
      if (!isDay(day) || day > beirutToday()) return json({ error: 'Choose a day.' }, 400);
      if (body.action === 'pricing_day') return json(await pricingDay(day));
      if (!body.supplier) return json({ error: 'Choose a supplier.' }, 400);
      return json(await pricingSupplier(day, String(body.supplier), String(body.part || ''), Array.isArray(body.codes) ? body.codes.map(String) : [], String(body.name || ''),
        Array.isArray(body.docs) ? (body.docs as Record<string, unknown>[]).map(d => ({ doc: String(d.doc || ''), ret: !!d.ret })).filter(d => /^[A-Z]+\d+$/.test(d.doc)) : []));
    }
    if (body.action === 'sales_compare') {
      const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean))].slice(0, 300);
      const okDate = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
      const periods = (body.onlyDuring ? { during: [body.from, body.to] } : { during: [body.from, body.to], before: [body.baseFrom, body.baseTo] }) as Record<string, unknown[]>;   // onlyDuring: a sell-out's credit note
      if (!codes.length || !Object.values(periods).every(([a, b]) => okDate(a) && okDate(b) && String(a) <= String(b))) return json({ error: 'Bad dates or no codes.' }, 400);
      const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
      const codeOf = new Map(codes.map(c => [key(c), c]));
      const out: Record<string, Record<string, { qty: number; sales: number }>> = {};
      codes.forEach(c => { out[c] = { during: { qty: 0, sales: 0 }, before: { qty: 0, sales: 0 } }; });
      // a period across two years: one report per year
      const pieces = (a: string, b: string) => a.slice(0, 4) === b.slice(0, 4) ? [[a, b]] : [[a, `${a.slice(0, 4)}-12-31`], [`${b.slice(0, 4)}-01-01`, b]];
      for (const [name, [a, b]] of Object.entries(periods)) {
        for (const [f, t] of pieces(String(a), String(b))) {
          for (let i = 0; i < codes.length; i += 100) {
            const rows = await yearRows('/items_sales', { branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Monthly', group_by: ['item'], item: codes.slice(i, i + 100) });
            rows.forEach(r => { const c = codeOf.get(key(String(r.item ?? ''))); if (!c) return; out[c][name].qty += Number(r.total_quantity || 0); out[c][name].sales += Number(r.total_sales || 0); });
          }
        }
      }
      return json({ items: out });
    }
    // One item's details (owner, 2026-10-06; double-click in a promotion or a sell-out): the item and its prices,
    // its stock and price in every branch, and its cardex at Ajaltoun (kind: all | purchases | invoices; the last
    // 400 lines of the period, default the last 90 days).
    if (body.action === 'item_detail') {
      const code = String(body.code || '').trim(); if (!code) return json({ error: 'No code.' }, 400);
      const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
      const ok = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
      const to = ok(body.to) ? String(body.to) : today;
      const from = ok(body.from) ? String(body.from) : new Date(new Date(to + 'T00:00:00Z').getTime() - 89 * 864e5).toISOString().slice(0, 10);
      const kind = ['purchases', 'invoices'].includes(String(body.kind)) ? String(body.kind) : 'all';
      const BRANCHES = ['Ajaltoun', 'Mazraat Yachouh', 'Beit El Kikko', 'Achrafieh', 'Zalka'];
      const branches = await Promise.all(BRANCHES.map(async b => {
        try {
          const d = await dash(`/item-price-checker?${new URLSearchParams({ search: code, year: year(), branches: b })}`) as Record<string, unknown>;
          const rows = (Object.values(((d.branches as Record<string, Record<string, unknown[]>>) || {})[b] || {}).flat() as Record<string, unknown>[]);
          const hit = rows.find(r => key(String(r.ItemCode ?? '')) === key(code)) || null;
          return { branch: b, hit };
        } catch { return { branch: b, hit: null, error: true }; }
      }));
      const main = (branches.find(x => x.branch === BRANCH)?.hit || branches.find(x => x.hit)?.hit) as Record<string, unknown> | null;
      if (!main) return json({ error: 'Not found in the system.' }, 404);
      const t = (v: unknown) => String(v ?? '').trim();
      const item = { code: t(main.ItemCode), description: t(main.Description), size: t(main.Description4), barcode: t(main.Barcode), supplier: t(main.Supplier),
        section: t(main.Section), group: t(main.Group), subgroup: t(main['Sub-Group']), brand: t(main.Brand), department: t(main.Department), pack: main.Pack ?? null,
        price: main.Price ?? null, salePrice: unitSale(main), packPrice: main.SalePrice ?? null, promoted: !!Number(main.isPromoted || 0) };
      let cardex: Record<string, unknown> = { rows: [], summary: null, from, to, kind };
      try {
        const pieces = from.slice(0, 4) === to.slice(0, 4) ? [[from, to]] : [[from, `${from.slice(0, 4)}-12-31`], [`${to.slice(0, 4)}-01-01`, to]];
        let rows: Record<string, unknown>[] = [], summary: unknown = null;
        for (const [f, tt] of pieces) {
          const yc = (await toYear('item', [item.code], f.slice(0, 4)))[item.code] || [];
          if (!yc.length) continue;   // not in that year's records
          const d = await dash(`/item-cardex?${new URLSearchParams({ branch: BRANCH, item_code: yc[0], year: f.slice(0, 4), from_date: f, to_date: tt })}`) as Record<string, unknown>;
          const data = (d.data || {}) as Record<string, unknown>;
          rows = rows.concat((data.rows || []) as Record<string, unknown>[]); summary = data.summary || summary;
        }
        const isP = (r: Record<string, unknown>) => String(r.operation_code) === '15' || /purchase/i.test(String(r.operation_label || ''));
        const isI = (r: Record<string, unknown>) => String(r.operation_code) === '60' || /invoice/i.test(String(r.operation_label || ''));
        const all = rows;
        rows = rows.filter(r => kind === 'purchases' ? isP(r) : kind === 'invoices' ? isI(r) : true);
        const sum = (l: Record<string, unknown>[], k: string) => l.reduce((s, r) => s + Number(r[k] || 0), 0);
        cardex = { from, to, kind, summary, count: rows.length,
          totals: { purchasesIn: sum(all.filter(isP), 'qty_in'), invoicesOut: Math.abs(sum(all.filter(isI), 'qty_out')) },
          rows: rows.slice(-400).reverse().map(r => ({ date: r.date, doc: r.document_no, op: r.operation_label, type: r.document_type, details: r.details,
            in: r.qty_in, out: r.qty_out, unit: r.unit_price, net: r.net_unit_price, total: r.line_total, currency: r.currency, balance: r.running_balance })) };
      } catch (e) { console.warn('detail cardex', e); }
      return json({ item, branches: branches.map(x => ({ branch: x.branch, found: !!x.hit, stock: x.hit ? (x.hit as Record<string, unknown>).AvailableQuantity ?? null : null,
        price: x.hit ? (x.hit as Record<string, unknown>).Price ?? null : null, salePrice: x.hit ? unitSale(x.hit as Record<string, unknown>) : null,
        promoted: x.hit ? !!Number((x.hit as Record<string, unknown>).isPromoted || 0) : false })), cardex });
    }
    // Pasted barcodes or codes (owner, 2026-10-06), up to 200: the item each one is (its barcode or its code, or
    // the only answer), with description, normal price, price now, supplier, stock — or null when not found.
    if (body.action === 'items_lookup') {
      const tokens = [...new Set((Array.isArray(body.tokens) ? body.tokens : []).map(t => String(t).trim()).filter(Boolean))].slice(0, 200);
      const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
      const y = year(), out: Record<string, unknown> = {};
      for (let i = 0; i < tokens.length; i += 6) {
        await Promise.all(tokens.slice(i, i + 6).map(async tk => {
          try {
            const d = await dash(`/item-price-checker?${new URLSearchParams({ search: tk, year: y, branches: BRANCH })}`) as Record<string, unknown>;
            const rows = (Object.values(((d.branches as Record<string, Record<string, unknown[]>>) || {})[BRANCH] || {}).flat() as Record<string, unknown>[]);
            const hit = rows.find(r => key(String(r.Barcode ?? '')) === key(tk)) || rows.find(r => key(String(r.ItemCode ?? '')) === key(tk)) || (rows.length === 1 ? rows[0] : null);
            const t = (v: unknown) => String(v ?? '').trim();
            out[tk] = hit ? { code: t(hit.ItemCode), description: t(hit.Description), barcode: t(hit.Barcode), supplier: t(hit.Supplier), group: t(hit.Group), brand: t(hit.Brand),
              pack: hit.Pack ?? null, price: hit.Price ?? null, salePrice: unitSale(hit), promoted: !!Number(hit.isPromoted || 0), stock: hit.AvailableQuantity ?? null } : null;
          } catch (e) { console.warn('lookup', tk, e); out[tk] = null; }
        }));
      }
      return json({ items: out });
    }
    // Pick items from the system (owner, 2026-10-06): the lists (supplier, brand, group, sub-group, section…) …
    const FIELDS = ['supplier', 'brand', 'group', 'subgroup', 'section', 'segment', 'subsegment', 'department', 'area'];
    if (body.action === 'filter_options') {
      const field = String(body.field || '');
      if (!FIELDS.includes(field)) return json({ error: 'Unknown list.' }, 400);
      const q = String(body.q || '').trim();
      const d = await dash(`/items/filter-options/${field}?${new URLSearchParams({ year: year(), limit: '50', ...(q ? { q } : {}) })}`) as Record<string, unknown>;
      return json({ options: (((d.data as Record<string, unknown>)?.options || []) as Record<string, unknown>[]).map(o => ({ code: String(o.code ?? ''), name: String(o.description ?? o.label ?? '') })) });
    }
    // … and the items of a choice: what was sold or bought this year at Ajaltoun (an item never sold nor bought
    // this year does not show).
    if (body.action === 'items_by') {
      const field = String(body.field || ''), codes = (Array.isArray(body.codes) ? body.codes : []).map(String).filter(Boolean).slice(0, 20);
      if (!FIELDS.includes(field) || !codes.length) return json({ error: 'Choose at least one.' }, 400);
      const y = year(), today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
      const base = { branches: [BRANCH], year: y, from_date: `${y}-01-01`, to_date: today, aggregation: 'Monthly', group_by: ['item'], [field]: codes };
      const items = new Map<string, { code: string; description: string; sold: number; bought: number }>();
      for (const [kind, path] of [['sold', '/items_sales'], ['bought', '/items_purchases']] as const) {
        try {
          const d = await dash(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base) });
          const rows = (((d as Record<string, unknown>)?.data as Record<string, unknown>)?.branches as Record<string, Record<string, unknown>[]>)?.[BRANCH] || [];
          rows.forEach(r => {
            const c = String(r.item ?? '').trim(); if (!c) return;
            const it = items.get(c) || { code: c, description: String(r.item_desc ?? ''), sold: 0, bought: 0 };
            it[kind] += Number(r.total_quantity || 0); if (!it.description) it.description = String(r.item_desc ?? '');
            items.set(c, it);
          });
        } catch (e) { console.warn('items_by', kind, e); }
      }
      return json({ items: [...items.values()].sort((a, b) => b.sold - a.sold) });
    }
    // Daily units / sales of a set of items (the sell-out trend), up to 300 codes, one year at most.
    if (body.action === 'sales_daily') {
      const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean))].slice(0, 300);
      const from = String(body.from || ''), to = String(body.to || '');
      if (!codes.length || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return json({ error: 'Bad dates or no codes.' }, 400);
      const days: Record<string, { qty: number; sales: number }> = {};
      const pieces = from.slice(0, 4) === to.slice(0, 4) ? [[from, to]] : [[from, `${from.slice(0, 4)}-12-31`], [`${to.slice(0, 4)}-01-01`, to]];
      for (const [f, t] of pieces) {
        const rows = await yearRows('/items_sales', { branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Daily', group_by: [], item: codes });
        rows.forEach(r => { const p = String(r.period || '').slice(0, 10); if (!p) return; days[p] = days[p] || { qty: 0, sales: 0 }; days[p].qty += Number(r.total_quantity || 0); days[p].sales += Number(r.total_sales || 0); });
      }
      return json({ days });
    }
    if (body.action === 'item_search') {
      const q = String(body.search ?? '').trim();
      if (q.length < 2) return json({ items: [] });
      return json({ items: (await search(q, String(body.branch || BRANCH))).map(slim) });
    }
    if (body.action === 'items_stock') {
      const codes = (Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean).slice(0, 300);
      const stock: Record<string, number | null> = {};
      const key = (c: string) => c.replace(/^0+(?=\d)/, '');
      for (let i = 0; i < codes.length; i += 6) {                 // a few at a time: light on their server
        await Promise.all(codes.slice(i, i + 6).map(async c => {
          try { const hit = (await search(c)).find(x => key(String(x.code)) === key(c)); stock[c] = hit ? (hit.available_quantity ?? null) : null; }
          catch { stock[c] = null; }
        }));
      }
      return json({ stock });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : 'Something went wrong' }, 502);
  }
});
