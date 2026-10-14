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
let ghostCols = true;   // stock_alerts has the ghost stock columns (migration 083); false once a write says otherwise
const GHOST_KEYS = ['ghost', 'last_sale', 'quiet_days', 'days_sold'];
async function stockWatch(onlyVendor?: string) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
  const from = new Date(new Date(today + 'T00:00:00Z').getTime() - 29 * 864e5).toISOString().slice(0, 10);
  let q = db.from('vendors').select('id, name, lead_time_days, system_suppliers, cover_days, stock_checked_at').eq('watch_stock', true);
  if (onlyVendor) q = q.eq('id', onlyVendor);
  const { data: vs, error } = await q.order('stock_checked_at', { ascending: true, nullsFirst: true });
  if (error) throw error;
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
  // a run stops after 90 s (the function's limit is 150 s): the vendors checked longest ago first, the next run goes on
  let budget = 450; const done: Record<string, unknown>[] = []; const started = Date.now();
  // the last FULL day the sales report has (it can lag behind today): the days without a sale (ghost stock) are counted
  // up to it, never into days the report does not have yet (that flagged nearly every regular seller)
  let fullEnd = plusDays(today, -1);
  try {
    const days = (await report('sales', plusDays(today, -6), today, { aggregation: 'Daily', group_by: [] }))
      .filter(r => Number(r.total_quantity || 0) > 0).map(r => String(r.period || '').slice(0, 10)).filter(Boolean).sort();
    if (days.length) { const last = days[days.length - 1]; fullEnd = last >= today ? plusDays(today, -1) : last; }
    else fullEnd = '';   // no sale at all in the report this week: do not judge ghost stock
  } catch (e) { console.warn('sales data end', e); fullEnd = ''; }
  for (const v of vs || []) {
    const sups = (Array.isArray(v.system_suppliers) ? v.system_suppliers : []).map((s: Record<string, unknown>) => String(s.code || '')).filter(Boolean);
    if (!sups.length) continue;
    if ((budget <= 0 || Date.now() - started > 90000) && done.length) break;
    // what sold in the last 30 days, day by day (the only items watched: no sales = not followed): the units, the days
    // it sold on, its last sale
    const sold = new Map<string, { code: string; description: string; qty: number; days: Set<string>; last: string }>();
    for (const [f, t] of from.slice(0, 4) === today.slice(0, 4) ? [[from, today]] : [[from, `${from.slice(0, 4)}-12-31`], [`${today.slice(0, 4)}-01-01`, today]]) {
      const rows = await yearRows('/items_sales', { branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Daily', group_by: ['item'], supplier: sups });
      rows.forEach(r => {
        const c = String(r.item ?? '').trim(); if (!c || c.includes(':')) return;
        const it = sold.get(c) || { code: c, description: String(r.item_desc ?? '').trim(), qty: 0, days: new Set<string>(), last: '' };
        const q = Number(r.total_quantity || 0), d = String(r.period || '').slice(0, 10);
        it.qty += q; if (q > 0 && d) { it.days.add(d); if (d > it.last) it.last = d; }
        sold.set(c, it);
      });
    }
    // the alerts still open for this vendor: every one is read again this round (owner, 2026-10-11: "I have 6 in stock,
    // why does it show 0?": an item flagged once, then out of the vendor's 150 best sellers, was never read again, and
    // its old stock stayed on the list)
    const { data: open } = await db.from('stock_alerts').select('code').eq('vendor_id', v.id).is('resolved_at', null);
    const openCodes = new Set<string>(((open || []) as { code: string }[]).map(x => String(x.code)));
    const ranked = [...sold.values()].filter(i => i.qty > 0).sort((a, b) => b.qty - a.qty);
    const items = [...ranked.slice(0, 150), ...ranked.slice(150).filter(i => openCodes.has(i.code))];
    const cover = Number(v.cover_days) > 0 ? Number(v.cover_days) : (Number(v.lead_time_days) > 0 ? Number(v.lead_time_days) : 3) + 4;
    const low: Record<string, unknown>[] = [], readOk = new Set<string>();
    for (let i = 0; i < items.length; i += 16) {
      await Promise.all(items.slice(i, i + 16).map(async it => {
        try {
          const d = await dash(`/items/search?${new URLSearchParams({ search: it.code, year: year(), preferred_branch: BRANCH })}`);
          const hit = (Array.isArray(d) ? d : []).find((x: Record<string, unknown>) => key(String(x.code ?? '')) === key(it.code)) as Record<string, unknown> | undefined;
          if (!hit || hit.available_quantity === null || hit.available_quantity === undefined) return;
          readOk.add(it.code);
          const stock = Number(hit.available_quantity), perDay = it.qty / 30, daysLeft = perDay > 0 ? stock / perDay : null;
          // ghost stock (owner, 2026-10-11: "the low stock doesn't fight the ghost stock"): the system shows stock, but an
          // item that sells regularly (on 6 days or more of the 30) has not sold for so long that it almost never happens
          // by chance: at its selling rate (the days before the quiet ones) at least 3 units would have sold in the full
          // days since its last sale (about a 5% chance of none), and at least 2 full days, counted up to the last full
          // day the sales report has (fullEnd). Most likely the shelf is empty (lost, stolen, in the storeroom, mis-scanned).
          const quiet = !fullEnd ? 0 : it.last ? Math.max(0, Math.round((Date.parse(fullEnd + 'T00:00:00Z') - Date.parse(it.last + 'T00:00:00Z')) / 864e5)) : 30;
          const rate = it.qty / Math.max(1, 30 - quiet);
          const ghost = !!fullEnd && stock > 0 && it.days.size >= 6 && quiet >= 2 && rate * quiet >= 3;
          if (stock <= 0 || (daysLeft !== null && daysLeft < cover) || ghost) low.push({ vendor_id: v.id, code: it.code, description: it.description || String(hit.description || ''),
            stock, sold30: it.qty, per_day: Math.round(perDay * 100) / 100, days_left: daysLeft === null ? null : Math.round(daysLeft * 10) / 10, cover_days: cover,
            ghost, last_sale: it.last || null, quiet_days: quiet, days_sold: it.days.size });
        } catch (e) { console.warn('stock', it.code, e); }
      }));
    }
    budget -= items.length;
    // the last PU of each item running low, and its units sold from that day to today (owner, 2026-10-06; migration 071)
    if (low.length) {
      try {
        const info = await lastPuSince(low.map(x => String(x.code)), today);
        low.forEach(x => Object.assign(x, info[String(x.code)] || { last_pu_state: 'none', last_pu_date: null, last_pu_qty: null, sold_since: null }));
      } catch (e) { console.warn('last pu', v.name, e); low.forEach(x => Object.assign(x, { last_pu_state: 'failed', last_pu_date: null, last_pu_qty: null, sold_since: null })); }
    }
    // a false flag (owner, 2026-10-06; migration 072): the system's stock contradicts its own last PU and the sales since
    // (Almaza Light: -26 in the system, 72 bought on 11-09, 21 sold since). Not running low: its count is wrong. Set apart.
    low.forEach(x => {
      const est = x.last_pu_state === 'ok' ? Number(x.last_pu_qty) - Number(x.sold_since) : null;
      x.est_stock = est === null ? null : Math.round(est * 1000) / 1000;
      // below 0 cannot be on a shelf: the count is wrong whatever the PU says (362 of 1,105 alerts on 2026-10-06)
      x.doubtful = Number(x.stock) < 0 || (est !== null && est > Number(x.stock) && est >= Number(x.per_day) * cover);
    });
    // keep the open ones, add the new ones, resolve the ones back above
    const now = new Date().toISOString(), lowCodes = new Set(low.map(x => String(x.code)));
    for (const x0 of low) {
      // the ghost columns (migration 083) are left out while that migration is not run, so the watch keeps working
      const x = ghostCols ? x0 : Object.fromEntries(Object.entries(x0).filter(([k]) => !GHOST_KEYS.includes(k)));
      const write = () => openCodes.has(String(x.code))
        ? db.from('stock_alerts').update({ ...x, last_seen: now }).eq('vendor_id', v.id).eq('code', x.code)
        : db.from('stock_alerts').upsert({ ...x, first_seen: now, last_seen: now, resolved_at: null });
      const { error: we } = await write();
      if (we && ghostCols && /ghost|last_sale|quiet_days|days_sold/.test(we.message)) {
        ghostCols = false; GHOST_KEYS.forEach(k => delete (x as Record<string, unknown>)[k]); await write();
      } else if (we) console.warn('stock alert save', x.code, we.message);
    }
    // resolved: read this round and not low any more, or no sale at all in the last 30 days (not followed any more).
    // One whose read failed stays as it is (never resolved on a guess)
    const back = [...openCodes].filter(c => !lowCodes.has(c) && (readOk.has(c) || !sold.has(c) || !(sold.get(c)!.qty > 0)));
    if (back.length) await db.from('stock_alerts').update({ resolved_at: now }).eq('vendor_id', v.id).in('code', back);
    await db.from('vendors').update({ stock_checked_at: now }).eq('id', v.id);
    done.push({ vendor: v.name, items: items.length, low: low.length, newlyLow: low.filter(x => !openCodes.has(String(x.code))).length, backAbove: back.length });
  }
  return { checked: done };
}

// the last purchase day (12 months back) of these items, its quantity, and the units sold from that day to today included
async function lastPuSince(codes: string[], today: string) {
  const want = new Set(codes.map(trimCode)), last: Record<string, { day: string; qty: number }> = {};
  for (let i = 0; i < codes.length; i += 150) {
    const part = codes.slice(i, i + 150);
    (await report('purchases', plusDays(today, -365), today, { aggregation: 'Daily', group_by: ['item'], item: part })).forEach(r => {
      const c = trimCode(r.item), d = String(r.period || '').slice(0, 10), q = Number(r.total_quantity || 0);
      if (!want.has(c) || q <= 0 || !d) return;
      if (!last[c] || d > last[c].day) last[c] = { day: d, qty: q }; else if (d === last[c].day) last[c].qty += q;
    });
  }
  const out: Record<string, Record<string, unknown>> = {};
  const withPu = Object.keys(last);
  if (!withPu.length) return out;
  const from = withPu.reduce((m, c) => last[c].day < m ? last[c].day : m, today), sold: Record<string, number> = {};
  for (let i = 0; i < withPu.length; i += 150) {
    (await report('sales', from, today, { aggregation: 'Daily', group_by: ['item'], item: withPu.slice(i, i + 150) })).forEach(r => {
      const c = trimCode(r.item), d = String(r.period || '').slice(0, 10);
      if (last[c] && d >= last[c].day) sold[c] = (sold[c] || 0) + Number(r.total_quantity || 0);
    });
  }
  withPu.forEach(c => { out[c] = { last_pu_state: 'ok', last_pu_date: last[c].day, last_pu_qty: Math.round(last[c].qty * 1000) / 1000, sold_since: Math.round((sold[c] || 0) * 1000) / 1000 }; });
  return out;
}

/* ---------------- big purchases (owner, 2026-10-06; migration 071) ----------------
   Today's and yesterday's purchases, item by item, against the item's usual order: its purchase days in the 12 months
   before (at least 2 of them), the median quantity. Big = at least 3 times the usual quantity, worth $100 or more, and more
   than 6 weeks of sales (the last 90 days' rate; or no sale at all). For each: the PU number(s) and the supplier (cardex).
   The cardex's user_id is a line id, not the person who entered the PU: not kept. Saved in big_purchases; push-alerts notifies once per PU. */
const GENERIC_ITEM = /^\s*(MARCHANDISE\b|EXTRA ITEM\b)/i;
async function bigBuys() {
  const today = beirutToday(), yday = plusDays(today, -1);
  const buys = new Map<string, { code: string; day: string; qty: number; value: number; description: string; supplier: string }>();
  (await report('purchases', yday, today, { aggregation: 'Daily', group_by: ['item'] })).forEach(r => {
    const c = trimCode(r.item), d = String(r.period || '').slice(0, 10), q = Number(r.total_quantity || 0), v = Number(r.total_purchases || 0);
    if (!c || c.includes(':') || !d || q <= 0) return;
    const k = c + '|' + d, x = buys.get(k) || { code: c, day: d, qty: 0, value: 0, description: String(r.item_desc ?? '').trim(), supplier: '' };
    x.qty += q; x.value += v; buys.set(k, x);
  });
  // placeholder items of the system ("MARCHANDISE AVEC TVA", "EXTRA ITEM /TVA": a value booked, not goods) are left out (owner, 2026-10-12)
  const cand = [...buys.values()].filter(b => b.value >= 100 && !GENERIC_ITEM.test(b.description));
  if (!cand.length) return { bought: buys.size, checked: 0, big: 0 };
  const codes = [...new Set(cand.map(b => b.code))], hist: Record<string, Record<string, number>> = {}, sold90: Record<string, number> = {};
  for (let i = 0; i < codes.length; i += 150) {
    const part = codes.slice(i, i + 150);
    (await report('purchases', plusDays(today, -366), plusDays(yday, -1), { aggregation: 'Daily', group_by: ['item'], item: part })).forEach(r => {
      const c = trimCode(r.item), d = String(r.period || '').slice(0, 10), q = Number(r.total_quantity || 0);
      if (q > 0 && d) { hist[c] = hist[c] || {}; hist[c][d] = (hist[c][d] || 0) + q; }
    });
    (await report('sales', plusDays(today, -90), yday, { group_by: ['item'], item: part })).forEach(r => { const c = trimCode(r.item); sold90[c] = (sold90[c] || 0) + Number(r.total_quantity || 0); });
  }
  const median = (a: number[]) => { const x = [...a].sort((p, q) => p - q), m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
  const big = cand.map(b => {
    const days = Object.entries(hist[b.code] || {}).filter(([d]) => d < b.day).map(([, q]) => q);
    if (days.length < 2) return null;
    const usual = median(days);
    if (!(usual > 0) || b.qty < 3 * usual) return null;
    const weekly = (sold90[b.code] || 0) / (90 / 7), weeks = weekly > 0 ? b.qty / weekly : null;
    if (weeks !== null && weeks < 6) return null;   // sells within 6 weeks: not a worry, not flagged
    return { ...b, usual, times: days.length, weekly, weeks };
  }).filter(Boolean) as (typeof cand[number] & { usual: number; times: number; weekly: number; weeks: number | null })[];
  const now = new Date().toISOString();
  for (const b of big) {
    let documents = '', supplier = '';
    try {
      if (b.day.slice(0, 4) === year()) {
        const cx = await dash(`/item-cardex?${new URLSearchParams({ branch: BRANCH, item_code: b.code, year: b.day.slice(0, 4), from_date: b.day, to_date: b.day })}`) as Record<string, unknown>;
        const rows = ((((cx.data as Record<string, unknown>)?.rows || []) as Record<string, unknown>[])).filter(isPurchase);
        documents = [...new Set(rows.map(r => String(r.document_no || '').trim()).filter(Boolean))].join(', ');
        supplier = [...new Set(rows.map(r => supName(r.details)).filter(Boolean))].join(', ');
      }
    } catch (e) { console.warn('big buy cardex', b.code, e); }
    const r2 = (v: number | null) => v === null ? null : Math.round(v * 100) / 100;
    const { error } = await db.from('big_purchases').upsert({ day: b.day, code: b.code, description: b.description, supplier: supplier || null, qty: r2(b.qty), value: r2(b.value),
      usual_qty: r2(b.usual), times: b.times, weekly_sales: r2(b.weekly), weeks_cover: r2(b.weeks), documents: documents || null, buyers: null, updated_at: now });
    if (error) console.warn('big buy save', b.code, error.message);
  }
  return { bought: buys.size, checked: cand.length, big: big.length };
}

/* ---------------- top sales (owner, 2026-10-11; migrations 073, 074) ----------------
   The items selling more than they used to, per day / week / month: the period's units (ending yesterday) against the
   average of the same-length periods before it. Flagged = at least the period's ratio and extra units, and it did sell
   before (a new item is not "more than it used to"). Each is put under the vendor whose linked system supplier sold it,
   with its stock now and the days that stock lasts at its selling rate (the faster of the period's and the last 7 days').
   attention = out of stock, or fewer days of stock than the vendor's cover days (lead time + 4, default 7).
   Run every day; saved in top_sales; push-alerts notifies the newly flagged. */
// the three views: the period's units against the average of the same-length periods just before it
const TOP_PERIODS = [
  { id: 'day',   days: 1,  baseDays: 28, baseCount: 28, ratio: 2,   minExtra: 3 },    // yesterday vs the daily average of the 4 weeks before
  { id: 'week',  days: 7,  baseDays: 56, baseCount: 8,  ratio: 1.5, minExtra: 4 },    // last 7 days vs the weekly average of the 8 weeks before
  { id: 'month', days: 30, baseDays: 90, baseCount: 3,  ratio: 1.3, minExtra: 10 },   // last 30 days vs the monthly average of the 3 months before
] as const;
// A run does ONE period (the store has ~150k items: the whole-store reads of the three periods in one call would not
// fit the function's time): the cron schedules three jobs a few minutes apart, "Count now" calls them one after another.
async function topSales(periodId: string) {
  const p = TOP_PERIODS.find(x => x.id === periodId);
  if (!p) throw new Error('Choose a period: day, week or month.');
  const yday = plusDays(beirutToday(), -1);
  const { data: vs, error } = await db.from('vendors').select('id, name, system_suppliers, cover_days, lead_time_days');
  if (error) throw error;
  const vendorOf = new Map<string, { id: string; name: string; cover: number }>();
  (vs || []).forEach(v => (Array.isArray(v.system_suppliers) ? v.system_suppliers : []).forEach((s: Record<string, unknown>) => {
    const c = trimCode(s.code); if (!c) return;
    const cover = Number(v.cover_days) > 0 ? Number(v.cover_days) : (Number(v.lead_time_days) > 0 ? Number(v.lead_time_days) : 3) + 4;
    vendorOf.set(c, { id: String(v.id), name: String(v.name), cover });
  }));
  type Row = { code: string; description: string; qty: number; supQty: Record<string, number> };
  const read = async (from: string, to: string, items?: string[]) => {
    const m = new Map<string, Row>();
    (await report('sales', from, to, { group_by: ['item', 'supplier'], ...(items ? { item: items } : {}) })).forEach(r => {
      const c = trimCode(r.item); if (!c || c.includes(':')) return;
      const q = Number(r.total_quantity || 0); if (!q) return;
      const it = m.get(c) || { code: c, description: '', qty: 0, supQty: {} };
      it.qty += q; if (!it.description) it.description = String(r.item_desc ?? '').trim();
      const s = trimCode(r.supplier); if (s) it.supQty[s] = (it.supQty[s] || 0) + q;
      m.set(c, it);
    });
    return m;
  };
  const recent = await read(plusDays(yday, -(p.days - 1)), yday);
  const baseTo = plusDays(yday, -p.days), base = await read(plusDays(baseTo, -(p.baseDays - 1)), baseTo);
  const found: { it: Row; usual: number }[] = [];
  for (const it of recent.values()) {
    const usual = (base.get(it.code)?.qty || 0) / p.baseCount;
    if (usual > 0 && it.qty / usual >= p.ratio && it.qty - usual >= p.minExtra) found.push({ it, usual });
  }
  const top = found.sort((a, b) => (b.it.qty - b.usual) - (a.it.qty - a.usual)).slice(0, 50);
  // the last 7 days' units of these items only (one small read): the rate for "how long will the stock last"
  const last7 = p.id === 'week' ? recent : top.length ? await read(plusDays(yday, -6), yday, top.map(h => h.it.code)) : new Map<string, Row>();
  // the stock now of each, 16 lookups at a time
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
  const stock: Record<string, number | null> = {};
  for (let i = 0; i < top.length; i += 16) {
    await Promise.all(top.slice(i, i + 16).map(async ({ it }) => {
      try {
        const d = await dash(`/items/search?${new URLSearchParams({ search: it.code, year: year(), preferred_branch: BRANCH })}`);
        const hit = (Array.isArray(d) ? d : []).find((x: Record<string, unknown>) => key(String(x.code ?? '')) === key(it.code)) as Record<string, unknown> | undefined;
        stock[it.code] = hit && hit.available_quantity !== null && hit.available_quantity !== undefined ? Number(hit.available_quantity) : null;
      } catch (e) { console.warn('top sales stock', it.code, e); stock[it.code] = null; }
    }));
  }
  const r2 = (v: number | null) => v === null ? null : Math.round(v * 100) / 100;
  const rows = top.map(({ it, usual }) => {
    const supplier = Object.entries(it.supQty).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const v = vendorOf.get(supplier), st = stock[it.code] ?? null;
    const perDay = Math.max(it.qty / p.days, (last7.get(it.code)?.qty || 0) / 7);
    const daysLeft = st !== null && perDay > 0 ? Math.max(0, st) / perDay : null;
    // attention: out of stock now, or it lasts fewer days than the vendor needs to be re-supplied (its cover days)
    const attention = st !== null && (st <= 0 || (daysLeft !== null && daysLeft < (v?.cover ?? 7)));
    return { week_end: yday, period: p.id, code: it.code, vendor_id: v?.id ?? null, supplier: v?.name ?? null, description: it.description || null,
      sold_week: r2(it.qty) as number, usual_week: r2(usual) as number, ratio: r2(it.qty / usual), stock: r2(st), per_day: r2(perDay),
      days_left: daysLeft === null ? null : Math.round(daysLeft * 10) / 10, attention };
  });
  await db.from('top_sales').delete().eq('week_end', yday).eq('period', p.id);   // a re-run replaces that period of that day
  await db.from('top_sales').delete().lt('week_end', plusDays(yday, -14));      // 14 days of daily sets kept
  if (rows.length) {
    const { error: e2 } = await db.from('top_sales').insert(rows);
    if (e2) throw e2;
  }
  return { week_end: yday, period: p.id, items: recent.size, flagged: rows.length, attention: rows.filter(r => r.attention).length };
}

/* ---------------- stock review (owner, 2026-10-11; migration 075) ----------------
   Overstock and slow movers, one kind per call (the store has ~150k items; only what moved is read).
   overstock: bought in the last 90 days; net = units bought - units sold; the biggest by value get their stock read;
     flagged when stock covers 12 weeks or more at the 90-day selling rate (or no sale), worth $50 or more.
   slow: units of the last 4 weeks against the 8 weeks before: at most half the weekly rate, with at least 8 units before;
     the biggest drops get their stock read; kept when there is stock left. Value = stock x the purchase cost, when known. */
async function stockReview(kind: string) {
  if (kind !== 'overstock' && kind !== 'slow') throw new Error('Choose overstock or slow.');
  const yday = plusDays(beirutToday(), -1);
  const { data: vs, error } = await db.from('vendors').select('id, name, system_suppliers');
  if (error) throw error;
  const vendorOf = new Map<string, { id: string; name: string }>();
  (vs || []).forEach(v => (Array.isArray(v.system_suppliers) ? v.system_suppliers : []).forEach((s: Record<string, unknown>) => {
    const c = trimCode(s.code); if (c) vendorOf.set(c, { id: String(v.id), name: String(v.name) });
  }));
  type Agg = { code: string; description: string; qty: number; value: number; supQty: Record<string, number> };
  const read = async (what: 'sales' | 'purchases', from: string, to: string) => {
    const m = new Map<string, Agg>();
    (await report(what, from, to, { group_by: ['item', 'supplier'] })).forEach(r => {
      const c = trimCode(r.item); if (!c || c.includes(':')) return;
      const q = Number(r.total_quantity || 0); if (!q) return;
      const it = m.get(c) || { code: c, description: '', qty: 0, value: 0, supQty: {} };
      it.qty += q; it.value += Number(what === 'sales' ? r.total_sales : r.total_purchases) || 0;
      if (!it.description) it.description = String(r.item_desc ?? '').trim();
      const s = trimCode(r.supplier); if (s) it.supQty[s] = (it.supQty[s] || 0) + q;
      m.set(c, it);
    });
    return m;
  };
  const supplierOf = (a: Agg) => Object.entries(a.supQty).sort((x, y) => y[1] - x[1])[0]?.[0] || '';
  type Cand = { a: Agg; per_week: number; prior_week: number | null; bought: number | null; sold: number | null; unit_cost: number | null; rank: number };
  let cands: Cand[] = [];
  if (kind === 'overstock') {
    const from = plusDays(yday, -89);
    const bought = await read('purchases', from, yday), sold = await read('sales', from, yday);
    for (const b of bought.values()) {
      const s = sold.get(b.code)?.qty || 0, unitCost = b.qty > 0 && b.value > 0 ? b.value / b.qty : null;
      const net = b.qty - s;                     // more bought than sold: something is piling up
      if (net <= 0 || unitCost === null) continue;
      cands.push({ a: b, per_week: s / (90 / 7), prior_week: null, bought: b.qty, sold: s, unit_cost: unitCost, rank: net * unitCost });
    }
  } else {
    const recent = await read('sales', plusDays(yday, -27), yday), prior = await read('sales', plusDays(yday, -83), plusDays(yday, -28));
    for (const p of prior.values()) {
      const priorWeek = p.qty / 8, nowWeek = (recent.get(p.code)?.qty || 0) / 4;
      if (p.qty < 8 || nowWeek > priorWeek * 0.5) continue;
      cands.push({ a: recent.get(p.code) || p, per_week: nowWeek, prior_week: priorWeek, bought: null, sold: null, unit_cost: null, rank: priorWeek - nowWeek });
    }
    // the units and cost of the last 90 days' purchases, for the value of what is left (only for the ones kept below)
  }
  cands = cands.sort((a, b) => b.rank - a.rank).slice(0, 70);
  // the stock now of each, 16 lookups at a time
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
  const stock: Record<string, number | null> = {};
  for (let i = 0; i < cands.length; i += 16) {
    await Promise.all(cands.slice(i, i + 16).map(async ({ a }) => {
      try {
        const d = await dash(`/items/search?${new URLSearchParams({ search: a.code, year: year(), preferred_branch: BRANCH })}`);
        const hit = (Array.isArray(d) ? d : []).find((x: Record<string, unknown>) => key(String(x.code ?? '')) === key(a.code)) as Record<string, unknown> | undefined;
        stock[a.code] = hit && hit.available_quantity !== null && hit.available_quantity !== undefined ? Number(hit.available_quantity) : null;
      } catch (e) { console.warn('stock review stock', a.code, e); stock[a.code] = null; }
    }));
  }
  // slow movers: the unit cost of what is still in stock = its purchases of the last 90 days (one small read, those items only)
  const cost = new Map<string, number>();
  if (kind === 'slow') {
    const withStock = cands.filter(c => (stock[c.a.code] ?? 0) > 0).map(c => c.a.code);
    for (let i = 0; i < withStock.length; i += 70) {
      try {
        (await report('purchases', plusDays(yday, -89), yday, { group_by: ['item'], item: withStock.slice(i, i + 70) })).forEach(r => {
          const c = trimCode(r.item), q = Number(r.total_quantity || 0), v = Number(r.total_purchases || 0);
          if (c && q > 0 && v > 0) cost.set(c, (cost.get(c) || 0) + v / q);
        });
      } catch (e) { console.warn('slow cost', e); }
    }
  }
  const r2 = (v: number | null) => v === null ? null : Math.round(v * 100) / 100;
  const rows = cands.map(c => {
    const st = stock[c.a.code] ?? null;
    const unit = c.unit_cost ?? cost.get(c.a.code) ?? null;
    const weeks = st !== null && c.per_week > 0 ? st / c.per_week : null;
    return { c, st, unit, weeks, value: st !== null && st > 0 && unit !== null ? st * unit : null };
  }).filter(x => x.st !== null && x.st > 0 && (kind === 'overstock'
    ? (x.weeks === null || x.weeks >= 12) && (x.value ?? 0) >= 50
    : true))
    .map(x => {
      const sup = supplierOf(x.c.a), v = vendorOf.get(sup);
      return { day: yday, kind, code: x.c.a.code, vendor_id: v?.id ?? null, supplier: v?.name ?? null, description: x.c.a.description || null,
        stock: r2(x.st), per_week: r2(x.c.per_week), prior_week: r2(x.c.prior_week), weeks_cover: r2(x.weeks), bought: r2(x.c.bought), sold: r2(x.c.sold),
        unit_cost: r2(x.unit), value: r2(x.value) };
    });
  await db.from('stock_review').delete().eq('day', yday).eq('kind', kind);          // a re-run replaces that day
  await db.from('stock_review').delete().lt('day', plusDays(yday, -14));            // 14 days kept
  if (rows.length) {
    const { error: e2 } = await db.from('stock_review').insert(rows);
    if (e2) throw e2;
  }
  return { day: yday, kind, candidates: cands.length, flagged: rows.length };
}

/* ---------------- stock snapshots (owner, 2026-10-11; migration 076) ----------------
   Every night, the stock of every item of the store that moved in the last year (sold in the last 90 days, or
   bought in the last 12 months: an item with stock and no movement at all cannot be listed, the system has no
   catalogue report), kept per day. The system has no bulk stock report, so it is read item by item: the list is
   built first (two calls: sales, then purchases), then as many as fit in 85 seconds per call (cron, every 2
   minutes during the night; about 150,000 items in one night). Once all are read, yesterday's stock -> today's is
   set against what the documents explain (units bought - units sold of the day): the rest is "unexplained"
   (count, adjustment, loss, return, wrong entry), saved in stock_moves. The day counted: before noon Beirut =
   yesterday (the night after closing), else today. */
const SNAP_MAX_ITEMS = 200000, SNAP_BUDGET_MS = 85000, SNAP_CONCURRENCY = 12;
async function stockSnapshot() {
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', hour12: false }));
  const day = hour < 12 ? plusDays(beirutToday(), -1) : beirutToday();
  const { data: run, error } = await db.from('stock_snapshot_runs').select('*').eq('day', day).maybeSingle();
  if (error) throw error;
  const started = Date.now();

  // 1a. the list of the day: what sold in the last 90 days
  if (!run) {
    const { data: vs } = await db.from('vendors').select('name, system_suppliers');
    const vendorName = new Map<string, string>();
    (vs || []).forEach(v => (Array.isArray(v.system_suppliers) ? v.system_suppliers : []).forEach((s: Record<string, unknown>) => { const c = trimCode(s.code); if (c) vendorName.set(c, String(v.name)); }));
    const items = new Map<string, { code: string; description: string; qty: number; supQty: Record<string, number> }>();
    (await report('sales', plusDays(day, -89), day, { group_by: ['item', 'supplier'] })).forEach(r => {
      const c = trimCode(r.item); if (!c || c.includes(':')) return;
      const q = Number(r.total_quantity || 0); if (q <= 0) return;
      const it = items.get(c) || { code: c, description: '', qty: 0, supQty: {} };
      it.qty += q; if (!it.description) it.description = String(r.item_desc ?? '').trim();
      const s = trimCode(r.supplier); if (s) it.supQty[s] = (it.supQty[s] || 0) + q;
      items.set(c, it);
    });
    const list = [...items.values()].sort((a, b) => b.qty - a.qty).slice(0, SNAP_MAX_ITEMS);
    for (let i = 0; i < list.length; i += 1000) {
      const { error: e } = await db.from('stock_snapshots').upsert(list.slice(i, i + 1000).map(it => {
        const sup = Object.entries(it.supQty).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        return { day, code: it.code, description: it.description || null, supplier: vendorName.get(sup) || null };
      }), { onConflict: 'day,code' });
      if (e) throw e;
    }
    await db.from('stock_snapshot_runs').upsert({ day, total: list.length, read: 0, list_stage: 1, started_at: new Date().toISOString() });
    await db.from('stock_snapshots').delete().lt('day', plusDays(day, -60));
    await db.from('stock_moves').delete().lt('day', plusDays(day, -60));
    await db.from('stock_snapshot_runs').delete().lt('day', plusDays(day, -60));
    return { day, step: 'list-sales', total: list.length };
  }

  // 1b. … plus what was bought in the last 12 months (stock may sit there without selling)
  if (Number(run.list_stage || 0) < 2) {
    const extra = new Map<string, { code: string; description: string }>();
    (await report('purchases', plusDays(day, -364), day, { group_by: ['item'] })).forEach(r => {
      const c = trimCode(r.item); if (!c || c.includes(':') || Number(r.total_quantity || 0) <= 0) return;
      if (!extra.has(c)) extra.set(c, { code: c, description: String(r.item_desc ?? '').trim() });
    });
    const room = Math.max(0, SNAP_MAX_ITEMS - Number(run.total || 0));
    const list = [...extra.values()].slice(0, room);
    for (let i = 0; i < list.length; i += 1000) {
      // an item already listed (it sold) keeps its row: ignore the duplicates
      const { error: e } = await db.from('stock_snapshots').upsert(list.slice(i, i + 1000).map(it => ({ day, code: it.code, description: it.description || null })),
        { onConflict: 'day,code', ignoreDuplicates: true });
      if (e) throw e;
    }
    const { count } = await db.from('stock_snapshots').select('code', { count: 'exact', head: true }).eq('day', day);
    await db.from('stock_snapshot_runs').update({ total: count ?? run.total, list_stage: 2 }).eq('day', day);
    return { day, step: 'list-purchases', total: count ?? run.total };
  }

  // 2. stock reads, as many as fit in the time of one call
  if (!run.finished_at) {
    const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
    let readNow = 0;
    while (Date.now() - started < SNAP_BUDGET_MS) {
      const { data: todo, error: e1 } = await db.from('stock_snapshots').select('code').eq('day', day).is('read_at', null).order('code').limit(240);
      if (e1) throw e1;
      if (!todo?.length) {
        await db.from('stock_snapshot_runs').update({ finished_at: new Date().toISOString(), read: Number(run.read || 0) + readNow }).eq('day', day);
        return { day, step: 'finished', total: run.total, read: Number(run.read || 0) + readNow };
      }
      const out: { day: string; code: string; stock: number | null; read_at: string }[] = [];
      for (let i = 0; i < todo.length && Date.now() - started < SNAP_BUDGET_MS + 20000; i += SNAP_CONCURRENCY) {
        await Promise.all(todo.slice(i, i + SNAP_CONCURRENCY).map(async ({ code }) => {
          let stock: number | null = null;
          try {
            const d = await dash(`/items/search?${new URLSearchParams({ search: code, year: year(), preferred_branch: BRANCH })}`);
            const hit = (Array.isArray(d) ? d : []).find((x: Record<string, unknown>) => key(String(x.code ?? '')) === key(code)) as Record<string, unknown> | undefined;
            if (hit && hit.available_quantity !== null && hit.available_quantity !== undefined) stock = Number(hit.available_quantity);
          } catch (e) { console.warn('snapshot stock', code, e); }
          out.push({ day, code, stock, read_at: new Date().toISOString() });
        }));
      }
      for (let i = 0; i < out.length; i += 200) {
        const { error: e2 } = await db.from('stock_snapshots').upsert(out.slice(i, i + 200), { onConflict: 'day,code' });
        if (e2) throw e2;
      }
      readNow += out.length;
    }
    await db.from('stock_snapshot_runs').update({ read: Number(run.read || 0) + readNow }).eq('day', day);
    return { day, step: 'read', read: Number(run.read || 0) + readNow, total: run.total };
  }

  // 3. the movements the documents do not explain (needs the previous finished day)
  if (!run.diff_done) {
    const { data: prevRun } = await db.from('stock_snapshot_runs').select('day').lt('day', day).not('finished_at', 'is', null).order('day', { ascending: false }).limit(1).maybeSingle();
    const stocks = async (d: string) => {
      const m = new Map<string, { stock: number; description: string; supplier: string }>();
      for (let from = 0; ; from += 1000) {
        const { data, error: e } = await db.from('stock_snapshots').select('code, stock, description, supplier').eq('day', d).not('stock', 'is', null).order('code').range(from, from + 999);
        if (e) throw e;
        (data || []).forEach(r => m.set(String(r.code), { stock: Number(r.stock), description: String(r.description || ''), supplier: String(r.supplier || '') }));
        if ((data || []).length < 1000) break;
      }
      return m;
    };
    let moves = 0;
    // two consecutive days only: otherwise the change holds the documents of several days
    if (prevRun?.day && Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(String(prevRun.day) + 'T00:00:00Z')) / 864e5) === 1) {
      const [prev, now] = await Promise.all([stocks(String(prevRun.day)), stocks(day)]);
      const sum = async (what: 'sales' | 'purchases') => {
        const m = new Map<string, number>();
        (await report(what, day, day, { group_by: ['item'] })).forEach(r => { const c = trimCode(r.item); if (c) m.set(c, (m.get(c) || 0) + Number(r.total_quantity || 0)); });
        return m;
      };
      const [sold, bought] = await Promise.all([sum('sales'), sum('purchases')]);
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const rows: Record<string, unknown>[] = [];
      for (const [code, n] of now) {
        const p = prev.get(code); if (!p) continue;
        const b = bought.get(code) || 0, s = sold.get(code) || 0;
        const un = (n.stock - p.stock) - (b - s);
        if (Math.abs(un) < 3) continue;   // rounding, pack / piece noise
        rows.push({ day, code, description: n.description || null, supplier: n.supplier || null, stock_prev: r2(p.stock), stock_now: r2(n.stock), bought: r2(b), sold: r2(s), unexplained: r2(un) });
      }
      rows.sort((a, b) => Math.abs(Number(b.unexplained)) - Math.abs(Number(a.unexplained)));
      const keep = rows.slice(0, 500);
      await db.from('stock_moves').delete().eq('day', day);
      for (let i = 0; i < keep.length; i += 200) {
        const { error: e3 } = await db.from('stock_moves').insert(keep.slice(i, i + 200));
        if (e3) throw e3;
      }
      moves = keep.length;
    }
    await db.from('stock_snapshot_runs').update({ diff_done: true }).eq('day', day);
    return { day, step: 'moves', moves };
  }
  return { day, step: 'done', total: run.total, read: run.read };
}

/* ---------------- the system's purchase orders (owner, 2026-10-11; migration 082) ----------------
   The POs of the last 7 days (/wms/purchase-orders, 200 a page, newest first) and their item lines (the document
   viewer: POST /operations/viewer, document_type PO, no operation code -> operation 05 "Purchase Order"). A PO's status
   stays "draft" in the system even once received, so a line counts as received when a PU of that item was entered on
   or after the PO's day (the daily purchases report), or when the PO has nothing remaining (WMS receiving).
   Saved in system_pos / system_po_lines; the app flags an item out of stock that is on an open PO. */
const PO_DAYS = 7, PO_BUDGET_MS = 80000;   // the POs of the week (owner, 2026-10-11)
/* ---------------- auto-receive from a new PU (owner, 2026-10-13; migration 094) ----------------
   A sent order (status 'pending') whose supplier shows a new purchase (PU) in the system on/after the day it was sent is
   flagged delivered by itself, stamped auto (received_by_name 'Auto · new PU', auto_received = true), fully reversible.
   Only vendors linked to a system supplier can match; the oldest open order of a supplier takes the earliest new PU; a PU
   day already matched to one order is not reused for another. push-alerts notifies the vendors managers (once per order). */
// the system's suppliers, from their purchases of the last 12 months (owner, 2026-10-13: import vendors straight from the system)
async function supplierCatalog() {
  const today = beirutToday(), from = plusDays(today, -364);
  const m = new Map<string, { code: string; name: string; purchases: number; units: number; months: Set<string> }>();
  (await report('purchases', from, today, { group_by: ['supplier'] })).forEach(r => {
    const c = trimCode(r.supplier); if (!c || c.includes(':')) return;
    const x = m.get(c) || { code: c, name: String(r.supplier_desc ?? '').trim() || c, purchases: 0, units: 0, months: new Set<string>() };
    x.purchases += Number(r.total_purchases || 0); x.units += Number(r.total_quantity || 0);
    const mo = String(r.period || '').slice(0, 7); if (mo) x.months.add(mo);
    if (!x.name && r.supplier_desc) x.name = String(r.supplier_desc).trim();
    m.set(c, x);
  });
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const suppliers = [...m.values()].map(x => ({ code: x.code, name: x.name, purchases: r2(x.purchases), units: r2(x.units), active_months: x.months.size }))
    .sort((a, b) => b.purchases - a.purchases);
  return { from, to: today, suppliers };
}

// sales across all branches (owner, 2026-10-13: a dashboard card; daily, not month to date). The system gives sales and
// units per branch, not a transaction count. One day (today by default) and the day before it, in one summary call
// each around the cache; today may be a few minutes old.
const BRANCHES = ['Ajaltoun', 'Mazraat Yachouh', 'Beit El Kikko', 'Achrafieh', 'Zalka'];
async function branchSales(dayIn?: string) {
  const today = beirutToday(), day = isDay(dayIn) && String(dayIn) <= today ? String(dayIn) : today, prev = plusDays(day, -1);
  const read = async (d: string) => {
    const r = await dash('/items_sales/summary', postJson({ branches: BRANCHES, year: d.slice(0, 4), from_date: d, to_date: d })) as Record<string, unknown>;
    const items = (((r.data as Record<string, unknown>)?.items || []) as Record<string, unknown>[]);
    const m: Record<string, { sales: number; qty: number }> = {};
    items.forEach(x => { const b = String(x.branch || '').trim(); if (!b) return; const y = m[b] = m[b] || { sales: 0, qty: 0 }; y.sales += Number(x.total_sales || 0); y.qty += Number(x.total_quantity || 0); });
    return m;
  };
  const [cur, before] = await Promise.all([read(day), read(prev)]);
  const r0 = (v: number) => Math.round(v * 100) / 100;
  const branches = BRANCHES.map(b => ({ branch: b, today: r0((cur[b]?.sales) || 0), todayQty: r0((cur[b]?.qty) || 0), prev: r0((before[b]?.sales) || 0), prevQty: r0((before[b]?.qty) || 0) }))
    .sort((a, b) => b.today - a.today);
  const sum = (k: 'today' | 'todayQty' | 'prev') => r0(branches.reduce((t, x) => t + x[k], 0));
  return { daily: true, day, prevDay: prev, isToday: day === today, branches, totalToday: sum('today'), totalQtyToday: sum('todayQty'), totalPrev: sum('prev') };
}

// Returns tracker sync (owner, 2026-10-13; migration 095): the recent PTs into public.pts. A small rolling window (default the
// last 4 days) so returns_range does not truncate; the owner's status and note are left alone by the trigger.
async function ptsSync(fromIn?: string, toIn?: string) {
  const today = beirutToday();
  const to = isDay(toIn) ? String(toIn) : today, from = isDay(fromIn) ? String(fromIn) : plusDays(to, -1);
  // day by day: a whole-range read truncates at 250 item-days on a busy store, so each day is read on its own
  const lines: Record<string, unknown>[] = []; let truncated = false;
  for (let d = to; d >= from; d = plusDays(d, -1)) { const r = await returnsRange(d, d); lines.push(...(r.lines as Record<string, unknown>[])); truncated = truncated || !!r.truncated; }
  const m = new Map<string, Record<string, unknown>>();
  (lines as Record<string, unknown>[]).forEach(x => {
    const doc = String(x.doc || '').trim(), day = String(x.day || '').slice(0, 10); if (!doc || !day) return;
    const year = day.slice(0, 4), k = doc + '|' + year;
    const g = (m.get(k) || { pt: doc, year, pt_date: day, supplier_code: trimCode(x.supplier), supplier_name: supName(x.supplierName || x.supplier), lines: 0, qty: 0, value: 0, currency: String(x.currency || '$') }) as Record<string, number | string>;
    (g.lines as number)++; (g.qty as number) += Math.abs(Number(x.paidQty || 0)) + Math.abs(Number(x.freeQty || 0)); (g.value as number) += Number(x.paid || 0);
    if (day < String(g.pt_date)) g.pt_date = day;
    m.set(k, g);
  });
  const now = new Date().toISOString(), rows = [...m.values()].map(g => ({ ...g, qty: Math.round(Number(g.qty) * 1000) / 1000, value: Math.round(Number(g.value) * 100) / 100, last_seen: now }));
  for (let i = 0; i < rows.length; i += 200) { const { error } = await db.from('pts').upsert(rows.slice(i, i + 200), { onConflict: 'pt,year' }); if (error) throw error; }
  return { from, to, pts: rows.length, truncated };
}

async function autoReceive() {
  const today = beirutToday();
  // the orders still waiting, oldest first, with their vendor's system supplier codes
  const { data: orders } = await db.from('vendor_orders')
    .select('id, vendor_id, vendor_name, order_date, expected_delivery, vendors(system_suppliers)')
    .eq('status', 'pending').order('order_date', { ascending: true });
  const open = (orders || []).map(o => {
    const vj = o.vendors as unknown as { system_suppliers?: { code?: string }[] } | { system_suppliers?: { code?: string }[] }[] | null;
    const row = Array.isArray(vj) ? vj[0] : vj;
    const sys = row?.system_suppliers;
    const codes = Array.isArray(sys) ? sys.map(s => trimCode(s.code)).filter(Boolean) : [];
    return { id: String(o.id), vendor_id: o.vendor_id, name: String(o.vendor_name || ''), from: String(o.order_date || '').slice(0, 10), codes };
  }).filter(o => o.codes.length && isDay(o.from));
  if (!open.length) return { pending: (orders || []).length, matched: 0, done: [] };

  // the new PUs of these suppliers since the earliest open order: per supplier code, the days with a purchase (qty > 0)
  const earliest = open.reduce((m, o) => o.from < m ? o.from : m, today);
  const codes = [...new Set(open.flatMap(o => o.codes))];
  const byCode = new Map<string, { day: string; value: number }[]>();
  try {
    const rows = await report('purchases', earliest, today, { aggregation: 'Daily', group_by: ['supplier'], supplier: codes });
    rows.forEach(r => {
      const c = trimCode(r.supplier), day = String(r.period || '').slice(0, 10), q = Number(r.total_quantity || 0), v = Number(r.total_purchases || 0);
      if (!c || !day || q <= 0) return;
      const l = byCode.get(c) || []; l.push({ day, value: v }); byCode.set(c, l);
    });
  } catch (e) { console.warn('auto-receive read', e); return { pending: open.length, matched: 0, done: [], failed: true }; }
  byCode.forEach(l => l.sort((a, b) => a.day.localeCompare(b.day)));

  const used = new Set<string>();                      // supplierCode|day already matched this run (one PU day → one order)
  const done: Record<string, unknown>[] = [];
  for (const o of open) {
    let hit: { day: string; value: number } | null = null, hitCode = '';
    for (const c of o.codes) {
      const pu = (byCode.get(c) || []).find(p => p.day >= o.from && !used.has(c + '|' + p.day));
      if (pu && (!hit || pu.day < hit.day)) { hit = pu; hitCode = c; }
    }
    if (!hit) continue;
    used.add(hitCode + '|' + hit.day);
    const d = hit.day; const info = `PU ${d.slice(8) + '-' + d.slice(5,7)} · $${Math.round(hit.value).toLocaleString('en-US')}`;
    const { error } = await db.from('vendor_orders').update({
      status: 'delivered', delivered_date: hit.day, received_at: new Date().toISOString(), received_by: null,
      received_by_name: 'Auto · new PU', receive_status: 'complete', auto_received: true, auto_received_pu: info,
    }).eq('id', o.id).eq('status', 'pending');
    if (error) { console.warn('auto-receive save', o.id, error.message); continue; }
    done.push({ id: o.id, vendor: o.name, day: hit.day, value: Math.round(hit.value), pu: info });
  }
  return { pending: open.length, matched: done.length, done };
}

async function poSync() {
  const started = Date.now(), today = beirutToday(), cutoff = plusDays(today, -PO_DAYS);
  // 1. the PO headers of the week (the last 7 days)
  const heads: Record<string, unknown>[] = [];
  for (let page = 1; page <= 25; page++) {
    const d = await dash(`/wms/purchase-orders?${new URLSearchParams({ page: String(page), page_size: '200' })}`) as Record<string, unknown>;
    const data = (d?.data || {}) as Record<string, unknown>, items = (data.items || []) as Record<string, unknown>[];
    const recent = items.filter(x => String(x.document_date || '').slice(0, 10) >= cutoff && String(x.branch_name || BRANCH) === BRANCH);
    heads.push(...recent);
    if (!(data.pagination as Record<string, unknown>)?.has_next || (items.length && !recent.length)) break;   // newest first: a page all older = done
  }
  const now = new Date().toISOString();
  const code = (h: Record<string, unknown>) => String(h.typecode || 'PO') + String(h.number || '');
  const { data: known } = await db.from('system_pos').select('po, line_count, lines_read_at').gte('po_date', cutoff);
  const kn = new Map<string, { line_count: number; lines_read_at: string | null }>((known || []).map((k: Record<string, unknown>) =>
    [String(k.po), { line_count: Number(k.line_count), lines_read_at: (k.lines_read_at as string) || null }]));
  const rows = heads.map(h => ({ po: code(h), year: String(h.year || today.slice(0, 4)), po_date: String(h.document_date).slice(0, 10), supplier_code: String(h.supplier_code || '') || null,
    supplier_name: String(h.supplier_name || '') || null, status: String(h.status || '') || null, line_count: Number(h.line_count || 0), requested_qty: Number(h.requested_qty_total || 0),
    received_qty: Number(h.received_qty_total || 0), remaining_qty: Number(h.remaining_qty_total ?? 0), seen_at: now }));
  for (let i = 0; i < rows.length; i += 200) { const { error } = await db.from('system_pos').upsert(rows.slice(i, i + 200)); if (error) throw error; }

  // 2. the lines of the new POs (and of the ones from today / yesterday, or whose line count changed: still being edited)
  const todo = rows.filter(r => { const k = kn.get(r.po); return !k || !k.lines_read_at || r.po_date >= plusDays(today, -1) || Number(k.line_count) !== r.line_count; });
  let readPos = 0;
  for (let i = 0; i < todo.length && Date.now() - started < PO_BUDGET_MS; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async r => {
      try {
        const d = await dash('/operations/viewer', postJson({ year: r.year, branch: BRANCH, document_type: 'PO', document_number: r.po.replace(/^[A-Z]+/, '') })) as Record<string, unknown>;
        const v = d?.data as Record<string, unknown> | undefined;
        if (!v || !Array.isArray(v.lines)) return;
        let lines = (v.lines as Record<string, unknown>[]).map((l, n) => ({ po: r.po, line: Number(l.line_number) || n + 1, po_date: r.po_date, supplier_code: r.supplier_code, supplier_name: r.supplier_name,
          code: trimCode(l.item_code), description: String(l.item_description || '').trim() || null, qty: Number(l.quantity || 0), unit_price: l.unit_price === null || l.unit_price === undefined ? null : Number(l.unit_price), read_at: now }))
          .filter(l => l.code);
        // a PO of last year (January): its codes are last year's, today's codes kept (migration 069); not prepared = as is
        if (r.year !== year()) { try { const m = await fromYear('item', lines.map(l => l.code), r.year); lines = lines.map(l => ({ ...l, code: m[l.code] || l.code })); } catch { /* as is */ } }
        await db.from('system_po_lines').delete().eq('po', r.po);
        if (lines.length) { const { error } = await db.from('system_po_lines').insert(lines); if (error) throw error; }
        await db.from('system_pos').update({ lines_read_at: now }).eq('po', r.po);
        readPos++;
      } catch (e) { console.warn('po lines', r.po, e); }
    }));
  }

  // 3. received, recounted every run (so a wrong mark corrects itself): a line is received when ITS SUPPLIER delivered
  //    that item (a PU of the item from the PO's supplier) on or after the PO's day, or when the PO has nothing remaining
  //    (WMS receiving). Any supplier's PU used to count (owner, 2026-10-11): an item bought every day was "received" the
  //    day it was ordered, and took its whole PO with it. Looked at over 30 days: a line not delivered stays on the
  //    "Not available" list until its item comes in (or 30 days).
  const keep = plusDays(today, -30);
  const sk = (c: unknown) => trimCode(c).replace(/^0+(?=\d)/, '').toUpperCase();
  type L = { po: string; line: number; po_date: string; code: string; supplier_code: string | null; received_on: string | null; po_delivered_on: string | null };
  type P = { po: string; requested_qty: number | null; remaining_qty: number | null; delivered_on: string | null };
  const all: L[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('system_po_lines').select('po, line, po_date, code, supplier_code, received_on, po_delivered_on').gte('po_date', keep)
      .order('po').order('line').range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []) as L[]);
    if ((data || []).length < 1000) break;
  }
  const { data: posAll } = await db.from('system_pos').select('po, requested_qty, remaining_qty, delivered_on').gte('po_date', keep);
  const poInfo = new Map(((posAll || []) as P[]).map(p => [p.po, p]));
  let received = 0, recounted = false;
  if (all.length && Date.now() - started < PO_BUDGET_MS + 20000) {
    const first = all.reduce((m, l) => l.po_date < m ? l.po_date : m, today), codes = [...new Set(all.map(l => l.code))];
    const days = new Map<string, string[]>();   // item|supplier -> its PU days since the oldest PO
    let failed = false;
    for (let i = 0; i < codes.length; i += 150) {
      try {
        (await report('purchases', first, today, { aggregation: 'Daily', group_by: ['item', 'supplier'], item: codes.slice(i, i + 150) })).forEach(r => {
          const k = sk(r.item) + '|' + sk(r.supplier), d = String(r.period || '').slice(0, 10);
          if (d && Number(r.total_quantity || 0) > 0) days.set(k, [...(days.get(k) || []), d]);
        });
      } catch (e) { console.warn('po received', e); failed = true; }
    }
    if (!failed) {   // a failed read never un-receives anything
      recounted = true;
      for (const l of all) {
        const p = poInfo.get(l.po), wmsDone = !!p && Number(p.requested_qty) > 0 && Number(p.remaining_qty) <= 0;
        const on = (days.get(sk(l.code) + '|' + sk(l.supplier_code)) || []).filter(d => d >= l.po_date).sort()[0] || (wmsDone ? (l.received_on || today) : null);
        if (on !== (l.received_on || null)) { await db.from('system_po_lines').update({ received_on: on }).eq('po', l.po).eq('line', l.line); l.received_on = on; }
        if (on) received++;
      }
    }
  }

  // 4. a PO is delivered once its supplier brought one of its items (the first such day): its other lines (no PU of their
  //    item from that supplier since) = NOT DELIVERED (po_delivered_on set, received_on null). Recounted with step 3.
  if (recounted) {
    const firstOf = new Map<string, string>();
    all.forEach(l => { if (l.received_on && (!firstOf.has(l.po) || l.received_on < firstOf.get(l.po)!)) firstOf.set(l.po, l.received_on); });
    const byPo = new Map<string, L[]>(); all.forEach(l => { if (!byPo.has(l.po)) byPo.set(l.po, []); byPo.get(l.po)!.push(l); });
    for (const [po, p] of poInfo) {
      const d = firstOf.get(po) || null;
      if ((p.delivered_on || null) !== d) await db.from('system_pos').update({ delivered_on: d }).eq('po', po);
      if ((byPo.get(po) || []).some(l => (l.po_delivered_on || null) !== d)) await db.from('system_po_lines').update({ po_delivered_on: d }).eq('po', po);
    }
  }
  const open = all.filter(l => !l.received_on && l.po_date >= cutoff);

  // 5. the stock now of the lines not delivered (read again every 2 hours): still out of stock = "Not available"
  let stockRead = 0;
  if (Date.now() - started < PO_BUDGET_MS + 40000) {
    const { data: missing } = await db.from('system_po_lines').select('po, line, code, stock_read_at').is('received_on', null).not('po_delivered_on', 'is', null)
      .gte('po_date', keep).order('stock_read_at', { ascending: true, nullsFirst: true }).limit(150);
    type Miss = { po: string; line: number; code: string; stock_read_at: string | null };
    const stale = ((missing || []) as Miss[]).filter(m => !m.stock_read_at || Date.now() - new Date(String(m.stock_read_at)).getTime() > 2 * 3600e3);
    const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase(), stockOf = new Map<string, number | null>();
    const codes = [...new Set(stale.map(m => String(m.code)))];
    for (let i = 0; i < codes.length && Date.now() - started < PO_BUDGET_MS + 50000; i += 12) {
      await Promise.all(codes.slice(i, i + 12).map(async c => {
        try {
          const d = await dash(`/items/search?${new URLSearchParams({ search: c, year: year(), preferred_branch: BRANCH })}`);
          const hit = (Array.isArray(d) ? d : []).find((x: Record<string, unknown>) => key(String(x.code ?? '')) === key(c)) as Record<string, unknown> | undefined;
          stockOf.set(c, hit && hit.available_quantity !== null && hit.available_quantity !== undefined ? Number(hit.available_quantity) : null);
        } catch (e) { console.warn('po stock', c, e); }
      }));
    }
    const at = new Date().toISOString();
    for (const m of stale) {
      if (!stockOf.has(String(m.code))) continue;
      await db.from('system_po_lines').update({ stock_now: stockOf.get(String(m.code)), stock_read_at: at }).eq('po', m.po).eq('line', m.line);
      stockRead++;
    }
  }

  // 30 days kept (the week's POs are the ones flagged; the lines not delivered stay listed up to 30 days)
  await db.from('system_pos').delete().lt('po_date', keep);   // their lines go with them
  return { pos: rows.length, linesRead: readPos, linesLeft: todo.length - readPos, openLines: open.length, received, stockRead };
}

/* ---------------- one supplier's last POs (owner, 2026-10-11; the vendor sheet's POs tab) ----------------
   Live from the system: its POs of the last 7 days only (owner: "the last PO in the last 7 days"; the PO list, newest
   first, read until a page goes older than that) and the lines of one of them (the newest, or `po`): each with the
   units that supplier delivered of it since the PO's day (the daily purchases report, its first day) and the stock now. */
async function vendorPos(sups: string[], wanted = '') {
  const sk = (c: unknown) => trimCode(c).replace(/^0+(?=\d)/, '').toUpperCase(), today = beirutToday(), cutoff = plusDays(today, -7);
  const mine = new Set(sups.map(sk));
  const pos: { po: string; year: string; po_date: string; supplier_code: string; supplier_name: string; lines: number; requested: number; received: number; remaining: number }[] = [];
  let looked = 0;
  for (let page = 1; page <= 10; page++) {
    const d = await dash(`/wms/purchase-orders?${new URLSearchParams({ page: String(page), page_size: '200' })}`) as Record<string, unknown>;
    const data = (d?.data || {}) as Record<string, unknown>, items = (data.items || []) as Record<string, unknown>[];
    looked += items.length;
    const week = items.filter(x => String(x.document_date || '').slice(0, 10) >= cutoff);
    week.filter(x => mine.has(sk(x.supplier_code)) && String(x.branch_name || BRANCH) === BRANCH).forEach(x => pos.push({
      po: String(x.typecode || 'PO') + String(x.number || ''), year: String(x.year || today.slice(0, 4)), po_date: String(x.document_date || '').slice(0, 10),
      supplier_code: trimCode(x.supplier_code), supplier_name: String(x.supplier_name || ''), lines: Number(x.line_count || 0),
      requested: Number(x.requested_qty_total || 0), received: Number(x.received_qty_total || 0), remaining: Number(x.remaining_qty_total ?? 0) }));
    if (!(data.pagination as Record<string, unknown>)?.has_next || week.length < items.length) break;   // newest first: older than the week = done
  }
  const list = pos.sort((a, b) => b.po_date.localeCompare(a.po_date) || b.po.localeCompare(a.po)), pick = list.find(p => p.po === wanted) || list[0];
  if (!pick) return { pos: [], po: null, looked, since: cutoff };
  return { pos: list, po: await poDetail(pick), looked, since: cutoff };
}

/* ---------------- the POs entered on a day (owner, 2026-10-11; Vendors › POs) ----------------
   The PO list, newest first, read until a page is all older than the day; then, on request, one PO's lines
   (poDetail: delivered by its supplier since the PO's day, and the stock now). */
async function posOfDay(day: string) {
  const out: Record<string, unknown>[] = [];
  for (let page = 1; page <= 15; page++) {
    const d = await dash(`/wms/purchase-orders?${new URLSearchParams({ page: String(page), page_size: '200' })}`) as Record<string, unknown>;
    const data = (d?.data || {}) as Record<string, unknown>, items = (data.items || []) as Record<string, unknown>[];
    items.filter(x => String(x.document_date || '').slice(0, 10) === day && String(x.branch_name || BRANCH) === BRANCH).forEach(x => out.push({
      po: String(x.typecode || 'PO') + String(x.number || ''), year: String(x.year || day.slice(0, 4)), po_date: day,
      supplier_code: trimCode(x.supplier_code), supplier_name: String(x.supplier_name || ''), lines: Number(x.line_count || 0),
      requested: Number(x.requested_qty_total || 0), received: Number(x.received_qty_total || 0), remaining: Number(x.remaining_qty_total ?? 0) }));
    if (!(data.pagination as Record<string, unknown>)?.has_next || (items.length && items.every(x => String(x.document_date || '').slice(0, 10) < day))) break;
  }
  return { day, pos: out.sort((a, b) => String(b.po).localeCompare(String(a.po))) };
}
type PoHead = { po: string; year: string; po_date: string; supplier_code: string; supplier_name?: string };
async function poDetail(pick: PoHead) {
  const sk = (c: unknown) => trimCode(c).replace(/^0+(?=\d)/, '').toUpperCase(), today = beirutToday();
  const v = (await dash('/operations/viewer', postJson({ year: pick.year, branch: BRANCH, document_type: 'PO', document_number: pick.po.replace(/^[A-Z]+/, '') })) as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const raw = (Array.isArray(v?.lines) ? v!.lines : []) as Record<string, unknown>[];
  const lines = raw.map((l, n) => ({ line: Number(l.line_number) || n + 1, code: trimCode(l.item_code), description: String(l.item_description || '').trim(), qty: Number(l.quantity || 0),
    unit_price: l.unit_price === null || l.unit_price === undefined ? null : Number(l.unit_price), total: Number(l.total_with_vat || 0),
    received: 0, received_on: null as string | null, stock: null as number | null })).filter(l => l.code);
  // delivered since the PO's day, by that supplier
  const codes = [...new Set(lines.map(l => l.code))];
  let receivedRead = true;
  for (let i = 0; i < codes.length; i += 150) {
    try {
      (await report('purchases', pick.po_date, today, { aggregation: 'Daily', group_by: ['item', 'supplier'], item: codes.slice(i, i + 150) })).forEach(r => {
        if (sk(r.supplier) !== sk(pick.supplier_code)) return;
        const q = Number(r.total_quantity || 0), d = String(r.period || '').slice(0, 10); if (q <= 0 || !d) return;
        lines.filter(l => sk(l.code) === sk(r.item)).forEach(l => { l.received += q; if (!l.received_on || d < l.received_on) l.received_on = d; });
      });
    } catch (e) { console.warn('vendor pos received', e); receivedRead = false; }
  }
  // the stock now, 12 at a time
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
  for (let i = 0; i < lines.length && i < 120; i += 12) {
    await Promise.all(lines.slice(i, i + 12).map(async l => {
      try {
        const d = await dash(`/items/search?${new URLSearchParams({ search: l.code, year: year(), preferred_branch: BRANCH })}`);
        const hit = (Array.isArray(d) ? d : []).find((x: Record<string, unknown>) => key(String(x.code ?? '')) === key(l.code)) as Record<string, unknown> | undefined;
        if (hit && hit.available_quantity !== null && hit.available_quantity !== undefined) l.stock = Number(hit.available_quantity);
      } catch (e) { console.warn('vendor pos stock', l.code, e); }
    }));
  }
  return { ...pick, total: Number(v?.total_with_vat || 0), currency: String(v?.currency || '$'), lines, receivedRead };
}

/* ---------------- margin watch (owner, 2026-10-12; migration 087) ----------------
   Each item bought today or yesterday is checked once: its PU of that day against its previous PU (item card, the last 200 days
   of the year), its price now (price checker), the PU's VAT (document viewer). See the migration for the kinds. Then the open
   flags are re-read (their price now, a new price sent from Pricing) and closed when the price followed. */
// since (server key only): check a day again - every item not checked since that time
async function marginWatch(onlyDay?: string, budget = 60, since = '') {
  const started = Date.now(), today = beirutToday();
  const days = onlyDay ? [onlyDay] : [plusDays(today, -1), today];
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase(), r4 = (v: number) => Math.round(v * 10000) / 10000;
  const vatCache = new Map<string, Record<string, { vat: number }> | null>();
  const docVat = async (doc: string, yr: string) => {
    const k = doc + yr; if (!vatCache.has(k)) { try { const v = await viewDoc(doc, false, yr); vatCache.set(k, v ? v.items : null); } catch { vatCache.set(k, null); } }
    return vatCache.get(k);
  };
  const priceNow = async (c: string) => {
    const d = await dash(`/item-price-checker?${new URLSearchParams({ search: c, year: year(), branches: BRANCH })}`) as Record<string, unknown>;
    const hit = (Object.values(((d.branches as Record<string, Record<string, unknown[]>>) || {})[BRANCH] || {}).flat() as Record<string, unknown>[]).find(x => key(String(x.ItemCode ?? '')) === key(c));
    if (!hit) return null;
    return { sale: unitSale(hit), currency: String(hit.CurrencyCode ?? '') === '01' ? 'LBP' : '$', promoted: !!Number(hit.isPromoted || 0), description: String(hit.Description ?? '').trim() };
  };
  const sentSince = async (codes: string[], day: string) => {
    if (!codes.length) return new Set<string>();
    const { data } = await db.from('price_changes').select('code, day, submitted_at').in('code', codes);
    return new Set((data || []).filter(r => String(r.day || '') >= day || String(r.submitted_at || '').slice(0, 10) >= day).map(r => String(r.code)));
  };
  let checked = 0, flagged = 0;
  for (const day of days) {
    if (Date.now() - started > 70000 || checked >= budget) break;
    const rows = await report('purchases', day, day, { aggregation: 'Daily', group_by: ['item'] });
    const bought = [...new Set(rows.filter(r => Number(r.total_quantity || 0) > 0).map(r => trimCode(r.item)).filter(c => c && !c.includes(':')))];
    if (!bought.length) continue;
    const done = new Set<string>();
    for (let i = 0; i < bought.length; i += 400) { const { data } = await db.from('margin_checks').select('code, checked_at').eq('day', day).in('code', bought.slice(i, i + 400)); (data || []).forEach(r => { if (!since || String(r.checked_at) >= since) done.add(String(r.code)); }); }
    const todo = bought.filter(c => !done.has(c)).slice(0, budget - checked);
    const sent = await sentSince(todo, day);
    const from = day.slice(0, 4) === plusDays(day, -200).slice(0, 4) ? plusDays(day, -200) : day.slice(0, 4) + '-01-01';
    const one = async (c: string) => {
      const row: Record<string, unknown> = { day, code: c, checked_at: new Date().toISOString() };
      try {
        const cx = await dash(`/item-cardex?${new URLSearchParams({ branch: BRANCH, item_code: c, year: day.slice(0, 4), from_date: from, to_date: day })}`) as Record<string, unknown>;
        const d = (cx.data as Record<string, unknown>) || {};
        row.description = String(d.item_description || '').trim() || null;
        const pu = ((d.rows || []) as Record<string, unknown>[]).filter(isPurchase);
        const byDate = new Map<string, Record<string, unknown>[]>(); pu.forEach(r => { const k = String(r.date || '').slice(0, 10); if (!byDate.has(k)) byDate.set(k, []); byDate.get(k)!.push(r); });
        const pick = (ls: Record<string, unknown>[]) => { const all = purchaseDocs(ls); return [...all].reverse().find(x => Number(x.paidQty) > 0) || null; };
        const cur = byDate.has(day) ? pick(byDate.get(day)!) : null;
        if (!cur || cur.realCost === null) { row.kind = 'failed'; return row; }
        const prevDay = [...byDate.keys()].filter(k => k < day).sort().reverse().find(k => pick(byDate.get(k)!));
        const prev = prevDay ? pick(byDate.get(prevDay)!) : null;
        const items = await docVat(String(cur.doc), day.slice(0, 4));
        const vat = !!items && Number(items[key(c)]?.vat || 0) > 0, f = vat ? 1.11 : 1;
        // the previous PU only when in the same currency (white kidney beans: $1.70 then 550,000 LBP)
        const curOf = (x: unknown) => /LBP|L\.?L/i.test(String(x)) ? 'LBP' : '$';
        const curCur = curOf(cur.currency), prevCur = prev ? curOf(prev.currency) : '';
        const cost = Number(cur.realCost) * f, pcost = prev && prev.realCost !== null && prevCur === curCur ? Number(prev.realCost) * f : null;
        Object.assign(row, { supplier: supName(cur.supplier) || null, doc: cur.doc, currency: String(cur.currency || '$'), vat, cost: r4(cost),
          prev_cost: pcost === null ? null : r4(pcost), prev_day: prevDay || null, prev_doc: prev ? prev.doc : null, cost_change: pcost ? r4(cost / pcost - 1) : null });
        const p = await priceNow(c);
        if (!p || p.sale === null || !(Number(p.sale) > 0)) { row.kind = 'failed'; return row; }
        const sale = Number(p.sale);
        Object.assign(row, { sale_price: r4(sale), sale_currency: p.currency, promoted: p.promoted, description: row.description || p.description || null });
        if (curCur !== p.currency) { row.kind = 'other_currency'; return row; }
        row.margin = r4((sale - cost) / sale); row.prev_margin = pcost === null ? null : r4((sale - pcost) / sale);
        // thresholds: a cent and 1% under the price (VAT rounding of suppliers sold at cost: Al Rifai $0.5006 for $0.50), a cost up
        // 3% and 2 cents (1,000 LBP); doubled or more since the last PU = a unit / pack change most likely (Alsohat tea +561%)
        const cent = curCur === 'LBP' ? 1000 : 0.02;
        if (cost > 2 * sale || (pcost !== null && cost >= 2 * pcost)) row.kind = 'check_unit';
        else if (!p.promoted && cost - sale >= Math.max(cent / 2, sale * 0.01)) row.kind = 'below_cost';
        else if (pcost !== null && cost >= pcost * 1.03 && cost - pcost >= cent) {
          row.kind = 'cost_up';
          if (sent.has(c)) { row.resolved_at = new Date().toISOString(); row.resolved_how = 'new price sent'; }
        } else row.kind = pcost === null ? 'no_previous' : null;
        return row;
      } catch (e) { console.warn('margin', c, e); row.kind = 'failed'; return row; }
    };
    for (let i = 0; i < todo.length; i += 8) {
      if (Date.now() - started > 80000) break;
      const out = await Promise.all(todo.slice(i, i + 8).map(one));
      const { error } = await db.from('margin_checks').upsert(out);
      if (error) throw error;
      checked += out.length; flagged += out.filter(r => ['cost_up', 'below_cost'].includes(String(r.kind)) && !r.resolved_at).length;
    }
  }
  // the open flags: did the price follow? (a new price sent from Pricing, or the price raised enough)
  let closed = 0;
  if (Date.now() - started < 100000) {
    const { data: open } = await db.from('margin_checks').select('day, code, cost, prev_cost, sale_price, kind, checked_at').in('kind', ['cost_up', 'below_cost']).is('resolved_at', null)
      .lt('checked_at', new Date(Date.now() - 2 * 3600e3).toISOString()).order('checked_at').limit(20);
    for (const r of open || []) {
      try {
        const sent = await sentSince([String(r.code)], String(r.day));
        const p = await priceNow(String(r.code)), now = new Date().toISOString();
        const sale = p && p.sale !== null ? Number(p.sale) : null, cost = Number(r.cost), pcost = r.prev_cost === null ? null : Number(r.prev_cost), was = Number(r.sale_price);
        const upd: Record<string, unknown> = { checked_at: now };
        if (sale !== null) { upd.sale_price = r4(sale); upd.margin = r4((sale - cost) / sale); if (pcost !== null) upd.prev_margin = r4((sale - pcost) / sale); }
        const followed = sale !== null && (r.kind === 'below_cost' ? sale > cost : pcost !== null && sale >= was * (cost / pcost) - 0.005);
        if (sent.size) Object.assign(upd, { resolved_at: now, resolved_how: 'new price sent' });
        else if (followed) Object.assign(upd, { resolved_at: now, resolved_how: 'price raised' });
        if (upd.resolved_at) closed++;
        await db.from('margin_checks').update(upd).eq('day', r.day).eq('code', r.code);
      } catch (e) { console.warn('margin recheck', r.code, e); }
    }
  }
  return { checked, flagged, closed, ms: Date.now() - started };
}

/* ---------------- the weekly report (owner, 2026-10-12; migration 089) ----------------
   Last week (Monday to Sunday, Beirut) on one page, kept in weekly_reports. Each part is read on its own: a part that fails says
   so ("could not be read") and the rest of the report is still made. */
async function weeklyReport(weekStart?: string) {
  const today = beirutToday();
  const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;   // Monday = 0
  const start = weekStart && isDay(weekStart) ? weekStart : plusDays(today, -dow - 7), end = plusDays(start, 6);
  const pStart = plusDays(start, -7), pEnd = plusDays(start, -1);
  const part = async <T>(name: string, fn: () => Promise<T>) => { try { return await fn(); } catch (e) { console.warn('weekly', name, e); return { failed: true } as unknown as T; } };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const sales = await part('sales', async () => {
    const d = await storeDaily(pStart, end), days = [];
    for (let i = 0; i < 7; i++) { const a = plusDays(start, i), b = plusDays(pStart, i); days.push({ day: a, sales: r2(d.days[a]?.sales || 0), prevDay: b, prev: r2(d.days[b]?.sales || 0) }); }
    return { total: r2(days.reduce((t, x) => t + x.sales, 0)), prev: r2(days.reduce((t, x) => t + x.prev, 0)), days };
  });
  const sections = await part('sections', async () => {
    const [a, b] = await Promise.all([salesCategories(start, end, 'section'), salesCategories(pStart, pEnd, 'section')]);
    const pm = new Map(b.rows.map(r => [r.code, r.sales]));
    const rows = a.rows.map(r => ({ name: r.name, sales: r2(r.sales), prev: r2(Number(pm.get(r.code) || 0)), diff: r2(r.sales - Number(pm.get(r.code) || 0)) }));
    return { up: [...rows].sort((x, y) => y.diff - x.diff).filter(x => x.diff > 0).slice(0, 6), down: [...rows].sort((x, y) => x.diff - y.diff).filter(x => x.diff < 0).slice(0, 6) };
  });
  const margin = await part('margin', async () => {
    const { data, error } = await db.from('margin_checks').select('day, code, description, supplier, doc, cost, prev_cost, cost_change, sale_price, margin, kind, resolved_at, currency')
      .gte('day', start).lte('day', end).in('kind', ['cost_up', 'below_cost']);
    if (error) throw error;
    const open = (data || []).filter(r => !r.resolved_at);
    return { costUp: (data || []).filter(r => r.kind === 'cost_up').length, below: (data || []).filter(r => r.kind === 'below_cost').length, closed: (data || []).filter(r => r.resolved_at).length,
      open: open.length, worst: open.sort((x, y) => Number(x.margin) - Number(y.margin)).slice(0, 8) };
  });
  const bigBuysW = await part('big', async () => {
    const { data, error } = await db.from('big_purchases').select('day, code, description, supplier, qty, usual_qty, value, weeks_cover, documents').gte('day', start).lte('day', end);
    if (error) throw error;
    const list = (data || []).filter(r => (r.weeks_cover === null || Number(r.weeks_cover) >= 6) && !GENERIC_ITEM.test(String(r.description || '')));
    return { count: list.length, top: list.sort((x, y) => Number(y.value) - Number(x.value)).slice(0, 6) };
  });
  const stock = await part('stock', async () => {
    const { data, error } = await db.from('stock_alerts').select('doubtful, ghost').is('resolved_at', null);
    if (error) throw error;
    const l = data || [];
    return { low: l.filter(r => !r.doubtful && !r.ghost).length, ghost: l.filter(r => r.ghost).length, wrongCount: l.filter(r => r.doubtful).length };
  });
  const pos = await part('pos', async () => {
    const { data, error } = await db.from('system_pos').select('po, po_date, supplier_name, line_count, delivered_on').is('delivered_on', null).lte('po_date', plusDays(end, -3)).gte('po_date', plusDays(end, -30));
    if (error) throw error;
    const { data: vo } = await db.from('vendor_orders').select('vendor_name, expected_delivery, status').eq('status', 'pending').lt('expected_delivery', plusDays(end, 1));
    return { notDelivered: (data || []).length, list: (data || []).sort((x, y) => String(x.po_date).localeCompare(String(y.po_date))).slice(0, 8), ordersLate: (vo || []).length };
  });
  const expiries = await part('expiries', async () => {
    const { data, error } = await db.from('expiries').select('description, supplier, expiry_date, qty, status, decision').gte('expiry_date', plusDays(end, 1)).lte('expiry_date', plusDays(end, 7));
    if (error) throw error;
    const l = (data || []).filter(r => !['done', 'closed'].includes(String(r.status || '')));
    return { count: l.length, list: l.sort((x, y) => String(x.expiry_date).localeCompare(String(y.expiry_date))).slice(0, 8) };
  });
  const cash = await part('cash', async () => {
    const [{ data, error }, { data: cs }] = await Promise.all([db.from('cash_differences').select('cashier_id, amount, currency').gte('day', start).lte('day', end), db.from('cashiers').select('id, name')]);
    if (error) throw error;
    const nm = new Map((cs || []).map(c => [c.id, c.name])), by = new Map<string, { name: string; lbp: number; usd: number; n: number }>();
    (data || []).forEach(r => { const x = by.get(r.cashier_id) || { name: String(nm.get(r.cashier_id) || '?'), lbp: 0, usd: 0, n: 0 }; if (String(r.currency) === 'USD' || r.currency === '$') x.usd += Number(r.amount); else x.lbp += Number(r.amount); x.n++; by.set(r.cashier_id, x); });
    const list = [...by.values()].sort((a, b) => a.lbp - b.lbp);
    return { list, lbp: list.reduce((t, x) => t + x.lbp, 0), usd: r2(list.reduce((t, x) => t + x.usd, 0)) };
  });
  const rentals = await part('rentals', async () => {
    const { data, error } = await db.from('rental_contracts').select('supplier, spot_id, end_date, amount, term').neq('term', 'temporary').gte('end_date', plusDays(end, 1)).lte('end_date', plusDays(end, 30));
    if (error) throw error;
    return { ending: (data || []).sort((x, y) => String(x.end_date).localeCompare(String(y.end_date))) };
  });
  const data = { start, end, prevStart: pStart, prevEnd: pEnd, made: new Date().toISOString(), sales, sections, margin, bigBuys: bigBuysW, stock, pos, expiries, cash, rentals };
  const { error } = await db.from('weekly_reports').upsert({ week_start: start, data, created_at: new Date().toISOString() });
  if (error) throw error;
  return data;
}

/* ---------------- the store's profit of a month (owner, 2026-10-12; migration 090) ----------------
   Gross profit, item by item, the way Performance does a supplier: each item sold x its unit cost (that month's purchases / units,
   free units included; else its purchases of the 3 months before). Apart, never guessed:
   - the butchery (section MEAT): its cuts are sold under codes that are never bought; the carcasses are bought as "VIANDE /KG"
     in the transitory items (Ohanness, Skaff, Mabsout: $130,491 in September 2026). Its sales and the meat bought that month are
     shown side by side, no margin claimed (in September 2026 the meat bought was twice its sales: stock, bulk, other uses);
   - what is booked without items (the other transitory lines: fees, charges, or a whole invoice on one line - WaelFood $53,720
     in August 2026): listed by supplier for the owner to say what it is, not counted;
   - the other sales without a cost (items not bought in those 4 months).
   Amounts in $ as the system reports them. */
async function monthProfit(month: string) {
  const from = month.slice(0, 7) + '-01', y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), today = beirutToday(), to = last < today ? last : today;
  const before = plusDays(from, -1), before3 = new Date(Date.UTC(y, m - 4, 1)).toISOString().slice(0, 10);
  const isMeat = (sec: string) => /^MEAT$/i.test(sec), isTransit = (sec: string) => /TRANSIT/i.test(sec), isViande = (d: string) => /^\s*VIANDE\b/i.test(d);
  type Agg = { v: number; q: number; sec: string; desc: string };
  const byItem = (rows: Record<string, unknown>[], val: string) => {
    const mm = new Map<string, Agg>();
    rows.forEach(r => { const c = trimCode(r.item); if (!c) return; const x = mm.get(c) || { v: 0, q: 0, sec: String(r.section_desc ?? '').trim(), desc: String(r.item_desc ?? '').trim() };
      x.v += Number(r[val] || 0); x.q += Number(r.total_quantity || 0); mm.set(c, x); });
    return mm;
  };
  const [sl, pu, pu3] = await Promise.all([
    report('sales', from, to, { group_by: ['section', 'item'] }),
    report('purchases', from, to, { group_by: ['section', 'supplier', 'item'] }),
    report('purchases', before3, before, { group_by: ['item'] }),
  ]);
  const S = byItem(sl, 'total_sales'), P = byItem(pu, 'total_purchases'), P3 = byItem(pu3, 'total_purchases');
  let sales = 0, cogs = 0, costed = 0, uncosted = 0, nUncosted = 0, meatSales = 0;
  S.forEach((x, c) => {
    sales += x.v;
    if (isMeat(x.sec)) { meatSales += x.v; return; }
    const p = P.get(c), p3 = P3.get(c);
    const unit = p && p.q > 0 && p.v > 0 ? p.v / p.q : p3 && p3.q > 0 && p3.v > 0 ? p3.v / p3.q : null;
    if (unit === null) { uncosted += x.v; if (x.v > 0) nUncosted++; return; }
    cogs += x.q * unit; costed += x.v;
  });
  // the purchases: the meat (section MEAT + "VIANDE" in the transitory items), and what is booked without items (the other
  // transitory lines: a fee, a charge, or a whole invoice on one line - WaelFood $53,720 in August 2026 - by supplier, for the
  // owner to say what it is; not counted in the profit)
  let meatSection = 0, viande = 0, extras = 0, purchases = 0;
  const extraBy = new Map<string, number>();
  pu.forEach(r => {
    const v = Number(r.total_purchases || 0), sec = String(r.section_desc ?? '').trim(), desc = String(r.item_desc ?? '').trim();
    purchases += v;
    if (isMeat(sec)) meatSection += v;
    else if (isTransit(sec)) { if (isViande(desc)) viande += v; else { extras += v; const k = String(r.supplier_desc ?? '').trim() + ' · ' + desc; extraBy.set(k, (extraBy.get(k) || 0) + v); } }
  });
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const detail = { butchery: { sales: r2(meatSales), meatSection: r2(meatSection), viande: r2(viande), bought: r2(meatSection + viande) },
    extras: r2(extras), extraBy: [...extraBy.entries()].filter(e => Math.abs(e[1]) >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, amount]) => ({ label, amount: r2(amount) })) };
  const row = { month: from, sales: r2(sales), cogs: r2(cogs), gross: r2(costed - cogs), costed_sales: r2(costed), uncosted_sales: r2(uncosted), uncosted_items: nUncosted,
    purchases: r2(purchases), by_section: detail, computed_at: new Date().toISOString() };
  const { error } = await db.from('store_months').upsert(row);
  if (error) throw error;
  return { ...row, to };
}

/* ---------------- the monthly supplier report (owner, 2026-10-12; migration 091) ----------------
   A supplier's month against the month before, item by item (sales and units; no cost, no margin), and the items bought in the
   3 months before that did not sell this month. The app adds the sell-outs and the rented spots and keeps the report. */
async function supplierReportData(sups: string[], month: string) {
  const from = month.slice(0, 7) + '-01', y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), today = beirutToday(), to = last < today ? last : today;
  const pFrom = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10), pTo = plusDays(from, -1);
  const b3 = new Date(Date.UTC(y, m - 4, 1)).toISOString().slice(0, 10);
  const [cur, prev, bought] = await Promise.all([
    report('sales', from, to, { group_by: ['item'], supplier: sups }),
    report('sales', pFrom, pTo, { group_by: ['item'], supplier: sups }),
    report('purchases', b3, to, { group_by: ['item'], supplier: sups }),
  ]);
  const agg = (rows: Record<string, unknown>[]) => { const mm = new Map<string, { code: string; name: string; sales: number; qty: number }>();
    rows.forEach(r => { const c = trimCode(r.item); if (!c || c.includes(':')) return; const x = mm.get(c) || { code: c, name: String(r.item_desc ?? '').trim(), sales: 0, qty: 0 };
      x.sales += Number(r.total_sales || 0); x.qty += Number(r.total_quantity || 0); mm.set(c, x); }); return mm; };
  const C = agg(cur), P = agg(prev);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const items = [...C.values()].map(x => ({ code: x.code, name: x.name, sales: r2(x.sales), qty: Math.round(x.qty * 1000) / 1000,
    prevSales: r2(P.get(x.code)?.sales || 0), prevQty: Math.round((P.get(x.code)?.qty || 0) * 1000) / 1000 })).sort((a, b) => b.sales - a.sales);
  const sold = new Set([...C.keys()].filter(c => (C.get(c)!.qty) > 0));
  const notSold = new Map<string, string>();
  bought.forEach(r => { const c = trimCode(r.item); if (c && !c.includes(':') && Number(r.total_quantity || 0) > 0 && !sold.has(c)) notSold.set(c, String(r.item_desc ?? '').trim()); });
  return { from, to, prevFrom: pFrom, prevTo: pTo,
    sales: r2(items.reduce((t, x) => t + x.sales, 0)), qty: Math.round(items.reduce((t, x) => t + x.qty, 0)),
    prevSales: r2([...P.values()].reduce((t, x) => t + x.sales, 0)), prevQty: Math.round([...P.values()].reduce((t, x) => t + x.qty, 0)),
    items, notSold: [...notSold.entries()].map(([code, name]) => ({ code, name })).slice(0, 60) };
}

/* ---------------- promotion ideas (owner, 2026-10-12; migration 092) ----------------
   Stock: the last full nightly snapshot (stock_snapshots). Sales: the last 30 days and the 60 before. Cost: the purchases of the
   last 6 months (value / units, as Performance). Reasons: expiring within 30 days (Expiries), stopped (stock, no sale in 30 days,
   sold in the 60 before), overstock (over 120 days of stock), big purchase (the last 30 days). Ranked by the money in stock; the
   price now from the price checker (items already on promotion left out); a suggested price per reason, never under the cost
   + 5% (the cost itself for an item about to expire). */
async function promoIdeas() {
  const today = beirutToday();
  const { data: run } = await db.from('stock_snapshot_runs').select('day').not('finished_at', 'is', null).order('day', { ascending: false }).limit(1);
  const day = run?.[0]?.day; if (!day) throw new Error('No full stock snapshot yet.');
  const stock = new Map<string, { desc: string; sup: string; stock: number }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('stock_snapshots').select('code, description, supplier, stock').eq('day', day).gt('stock', 0).range(from, from + 999);
    if (error) throw error;
    (data || []).forEach(r => stock.set(trimCode(r.code), { desc: String(r.description || ''), sup: String(r.supplier || ''), stock: Number(r.stock) }));
    if (!data || data.length < 1000) break;
  }
  const qtyOf = (rows: Record<string, unknown>[]) => { const m = new Map<string, number>(); rows.forEach(r => { const c = trimCode(r.item); if (c) m.set(c, (m.get(c) || 0) + Number(r.total_quantity || 0)); }); return m; };
  // one after the other: three big reports at once slow the dashboard past its time limit (2026-10-13)
  const s30 = await report('sales', plusDays(today, -30), plusDays(today, -1), { group_by: ['item'] });
  const s90 = await report('sales', plusDays(today, -90), plusDays(today, -31), { group_by: ['item'] });
  const pu = await report('purchases', plusDays(today, -182), plusDays(today, -1), { group_by: ['item'] });
  const Q30 = qtyOf(s30), Q90 = qtyOf(s90), cost = new Map<string, number>();
  const supOf = new Map<string, string>();   // filled below for the items picked (the snapshot does not keep the supplier)
  const pv = new Map<string, { v: number; q: number }>();
  pu.forEach(r => { const c = trimCode(r.item); if (!c) return; const x = pv.get(c) || { v: 0, q: 0 }; x.v += Number(r.total_purchases || 0); x.q += Number(r.total_quantity || 0); pv.set(c, x); });
  pv.forEach((x, c) => { if (x.q > 0 && x.v > 0) cost.set(c, x.v / x.q); });
  const [{ data: exps }, { data: bigs }] = await Promise.all([
    db.from('expiries').select('code, description, supplier, expiry_date, qty').eq('status', 'open').lte('expiry_date', plusDays(today, 30)).gte('expiry_date', today),
    db.from('big_purchases').select('code, description, supplier, weeks_cover').gte('day', plusDays(today, -30)),
  ]);
  type Idea = { code: string; desc: string; sup: string; stock: number | null; sold30: number; sold90: number; days: number | null; cost: number | null; value: number | null; reasons: string[]; expires?: string };
  const ideas = new Map<string, Idea>();
  const get = (c: string, desc: string, sup: string) => { let x = ideas.get(c); if (!x) { const st = stock.get(c); const s30v = Q30.get(c) || 0, cst = cost.get(c) ?? null;
    x = { code: c, desc: st?.desc || desc, sup: supOf.get(c) || st?.sup || sup, stock: st ? st.stock : null, sold30: s30v, sold90: Q90.get(c) || 0, days: st && s30v > 0 ? Math.round(st.stock / (s30v / 30)) : null,
      cost: cst, value: st && cst !== null ? st.stock * cst : null, reasons: [] }; ideas.set(c, x); } return x; };
  const GENERIC = /^s*(VIANDE|MARCHANDISE|EXTRA ITEM|CHARGE)/i;
  stock.forEach((st, c) => {
    if (GENERIC.test(st.desc)) return;
    const a = Q30.get(c) || 0, b = Q90.get(c) || 0;
    if (a <= 0 && b > 0) get(c, st.desc, st.sup).reasons.push('stopped');
    else if (a > 0 && st.stock / (a / 30) > 120) get(c, st.desc, st.sup).reasons.push('overstock');
  });
  (exps || []).forEach(e => { const x = get(trimCode(e.code), String(e.description || ''), String(e.supplier || '')); if (!x.reasons.includes('expiring')) x.reasons.unshift('expiring'); if (!x.expires || e.expiry_date < x.expires) x.expires = e.expiry_date; });
  (bigs || []).filter(b => b.weeks_cover === null || Number(b.weeks_cover) >= 8).forEach(b => { if (/^\s*(MARCHANDISE\b|EXTRA ITEM\b)/i.test(String(b.description || ''))) return; const x = get(trimCode(b.code), String(b.description || ''), String(b.supplier || '')); if (!x.reasons.includes('big')) x.reasons.push('big'); });
  // the most money in stock first; the expiring ones always in
  const list = [...ideas.values()].filter(x => x.reasons.length);
  const exp = list.filter(x => x.reasons.includes('expiring')).slice(0, 60);
  const rest = list.filter(x => !x.reasons.includes('expiring')).sort((a, b) => (b.value ?? -1) - (a.value ?? -1)).slice(0, 120 - exp.length);
  const pick = [...exp, ...rest];
  // the supplier of the items picked: their purchases of the last 6 months by supplier (a small read: these items only)
  try {
    const codes = pick.map(x => x.code);
    for (let i = 0; i < codes.length; i += 150) {
      (await report('purchases', plusDays(today, -182), plusDays(today, -1), { group_by: ['supplier', 'item'], item: codes.slice(i, i + 150) }))
        .forEach(r => { const c = trimCode(r.item), sname = String(r.supplier_desc ?? '').trim(); if (c && sname && Number(r.total_quantity || 0) > 0) supOf.set(c, sname); });
    }
    pick.forEach(x => { if (supOf.get(x.code)) x.sup = supOf.get(x.code)!; });
  } catch (e) { console.warn('idea suppliers', e); }
  const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase(), r2 = (v: number) => Math.round(v * 100) / 100;
  const DISC: Record<string, number> = { expiring: 0.25, stopped: 0.2, overstock: 0.15, big: 0.1 };
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < pick.length; i += 12) {
    await Promise.all(pick.slice(i, i + 12).map(async x => {
      let price: number | null = null, promoted = false, cur = '$';
      try {
        const d = await dash(`/item-price-checker?${new URLSearchParams({ search: x.code, year: year(), branches: BRANCH })}`) as Record<string, unknown>;
        const hit = (Object.values(((d.branches as Record<string, Record<string, unknown[]>>) || {})[BRANCH] || {}).flat() as Record<string, unknown>[]).find(h => key(String(h.ItemCode ?? '')) === key(x.code));
        if (hit) { price = unitSale(hit); promoted = !!Number(hit.isPromoted || 0); cur = String(hit.CurrencyCode ?? '') === '01' ? 'LBP' : '$'; }
      } catch (e) { console.warn('idea price', x.code, e); }
      if (promoted) return;
      if (price === null || !(price > 0)) return;   // no price in the system: nothing to promote
      // a cost per case against a price per piece (Torabika sachets: $4.33 a box, $0.30 a sachet): the unit differs, left out
      if (cur === '$' && x.cost !== null && (x.cost > 2 * price || price > 6 * x.cost)) return;
      const d = Math.max(...x.reasons.map(r => DISC[r] || 0.1));
      let sug: number | null = null, note = '';
      if (price !== null && price > 0 && cur === '$') {
        const floor = x.cost !== null ? x.cost * (x.reasons.includes('expiring') ? 1 : 1.05) : 0;
        sug = Math.max(price * (1 - d), floor);
        sug = Math.floor(sug * 20) / 20;   // to 5 cents
        if (sug >= price - 0.001) { sug = null; note = 'already near its cost: no room for a discount'; }
      } else if (cur === 'LBP') note = 'priced in LBP';
      if (x.days !== null && x.days > 365) note = (note ? note + '; ' : '') + `${Math.round(x.days / 30)} months of stock: check the count first`;
      if (x.cost !== null && cur === '$' && x.cost > price) note = (note ? note + '; ' : '') + 'sells below its cost now';
      out.push({ code: x.code, desc: x.desc, sup: x.sup, stock: x.stock, sold30: r2(x.sold30), sold90: r2(x.sold90), days: x.days, cost: x.cost === null ? null : r2(x.cost), value: x.value === null ? null : r2(x.value),
        reasons: x.reasons, expires: x.expires || null, price, currency: cur, suggested: sug, margin: sug !== null && x.cost !== null ? r2((sug - x.cost) / sug) : null, note });
    }));
  }
  const data = { day, made: new Date().toISOString(), items: out.sort((a, b) => Number((b.reasons as string[]).includes('expiring')) - Number((a.reasons as string[]).includes('expiring')) || Number(b.value ?? -1) - Number(a.value ?? -1)) };
  const { error } = await db.from('promo_ideas').upsert({ id: 1, data, made_at: data.made });
  if (error) throw error;
  return data;
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
/* ---------------- the store map's sales (owner, 2026-10-12; migration 088) ----------------
   The system's tree as it sells (department > section > group > sub-group, the whole path: codes repeat across parents),
   and the sales of a period per path. Today is asked around the dashboard's cache (from a rotating day before, today's rows
   kept, like the hourly measures). */
const CAT_BY = ['department', 'section', 'group', 'subgroup'];
type CatRow = { dep: string; sec: string; grp: string; sub: string; sales: number; qty: number };
function catRows(rows: Record<string, unknown>[], only?: (r: Record<string, unknown>) => boolean) {
  const m = new Map<string, CatRow & { dep_desc: string; sec_desc: string; grp_desc: string; sub_desc: string }>();
  rows.forEach(r => { if (only && !only(r)) return;
    const p = { dep: trimCode(r.department), sec: trimCode(r.section), grp: trimCode(r.group), sub: trimCode(r.subgroup) }, k = [p.dep, p.sec, p.grp, p.sub].join('|');
    const x = m.get(k) || { ...p, dep_desc: String(r.department_desc ?? '').trim(), sec_desc: String(r.section_desc ?? '').trim(), grp_desc: String(r.group_desc ?? '').trim(), sub_desc: String(r.subgroup_desc ?? '').trim(), sales: 0, qty: 0 };
    x.sales += Number(r.total_sales || 0); x.qty += Number(r.total_quantity || 0); m.set(k, x); });
  return [...m.values()];
}
async function catTree() {
  const today = beirutToday(), from = plusDays(today, -364);
  const list = catRows(await report('sales', from, today, { group_by: CAT_BY }));
  const now = new Date().toISOString(), r2 = (v: number) => Math.round(v * 100) / 100;
  const rows = list.map(x => ({ dep: x.dep, dep_desc: x.dep_desc, sec: x.sec, sec_desc: x.sec_desc, grp: x.grp, grp_desc: x.grp_desc, sub: x.sub, sub_desc: x.sub_desc, sales_12m: r2(x.sales), updated_at: now }));
  for (let i = 0; i < rows.length; i += 500) { const { error } = await db.from('sys_categories').upsert(rows.slice(i, i + 500)); if (error) throw error; }
  return { categories: rows.length, from, to: today };
}
async function mapSales(from: string, to: string) {
  const today = beirutToday(), out: CatRow[] = [];
  const add = (l: CatRow[]) => l.forEach(x => { const y = out.find(o => o.dep === x.dep && o.sec === x.sec && o.grp === x.grp && o.sub === x.sub); if (y) { y.sales += x.sales; y.qty += x.qty; } else out.push({ dep: x.dep, sec: x.sec, grp: x.grp, sub: x.sub, sales: x.sales, qty: x.qty }); });
  const end = to >= today ? plusDays(today, -1) : to;
  if (from <= end) add(catRows(await report('sales', from, end, { group_by: CAT_BY })));
  if (to >= today && from <= today) {
    const slot = Math.floor(Date.now() / 60000 / 5), day0 = plusDays(today, -(1 + slot % 12));
    add(catRows(await report('sales', day0, today, { aggregation: 'Daily', group_by: CAT_BY }), r => String(r.period || '').slice(0, 10) === today));
  }
  return { from, to, rows: out.map(x => ({ ...x, sales: Math.round(x.sales * 100) / 100, qty: Math.round(x.qty * 1000) / 1000 })) };
}
// the store's sales day by day (owner, 2026-10-11: Performance › Daily sales)
async function storeDaily(from: string, to: string) {
  const days: Record<string, { sales: number; qty: number }> = {};
  (await report('sales', from, to, { aggregation: 'Daily', group_by: [] })).forEach(r => {
    const d = String(r.period || '').slice(0, 10); if (!d) return;
    const x = days[d] = days[d] || { sales: 0, qty: 0 }; x.sales += Number(r.total_sales || 0); x.qty += Number(r.total_quantity || 0);
  });
  return { from, to, days };
}
// sales by category (owner, 2026-10-11: Performance › Categories): one level (department, section, group, subgroup, brand),
// optionally inside one parent (e.g. the groups of one section)
const CAT_LEVELS = ['department', 'section', 'group', 'subgroup', 'brand'];
async function salesCategories(from: string, to: string, level: string, parentLevel?: string, parentCode?: string) {
  const extra: Record<string, unknown> = { group_by: [level] };
  if (parentLevel && parentCode) extra[parentLevel] = [parentCode];
  const m = new Map<string, { code: string; name: string; sales: number; qty: number }>();
  (await report('sales', from, to, extra)).forEach(r => {
    const c = String(r[level] ?? '').trim() || '?';
    const x = m.get(c) || { code: c, name: String(r[level + '_desc'] ?? '').trim() || (c === '?' ? 'Not classified' : c), sales: 0, qty: 0 };
    x.sales += Number(r.total_sales || 0); x.qty += Number(r.total_quantity || 0); m.set(c, x);
  });
  return { from, to, level, rows: [...m.values()] };
}
// Sales by hour (owner, 2026-10-12; migration 086): today's running sales per section, kept when they changed since the last one.
// The day after midnight the job still runs until 00:45 Beirut: yesterday's last sync lands on yesterday.
async function salesSnapshot() {
  const now = new Date(), today = beirutToday(), hour = Number(now.toLocaleString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', hour12: false }));
  const day = hour < 2 ? plusDays(today, -1) : today;   // 00:00 - 01:59: the last sync of the day before
  // The dashboard caches a report by its exact question for a while (12-10: by section still $21,339 at 20:46 while the store
  // total was $21,490): each run asks from a different day before (rotating over 12 days) and keeps today's rows only, then
  // checks the sections add up to the store's total (asked the same way) - else it asks again from another day, and keeps
  // nothing rather than a stale figure.
  const slot = Math.floor((now.getTime() / 60000) / 15);
  let rows: Record<string, unknown>[] = [], fresh = 0, ok = false;
  for (let tryNo = 0; tryNo < 3 && !ok; tryNo++) {
    const from = plusDays(day, -(1 + (slot + tryNo * 5) % 12));
    const [tot, sec] = await Promise.all([report('sales', from, day, { aggregation: 'Daily', group_by: [] }), report('sales', from, day, { aggregation: 'Daily', group_by: ['section'] })]);
    const today = (r: Record<string, unknown>) => String(r.period || '').slice(0, 10) === day;
    fresh = tot.filter(today).reduce((t, r) => t + Number(r.total_sales || 0), 0);
    rows = sec.filter(today);
    ok = Math.abs(rows.reduce((t, r) => t + Number(r.total_sales || 0), 0) - fresh) < 0.5;
  }
  if (!ok) {
    // the sections never added up (the dashboard kept serving old section figures): keep the store's total anyway when it
    // moved, so the whole-store hours do not freeze for the rest of the day (owner, 2026-10-13: stuck at 12:45 at 20:36)
    const { data: lastT } = await db.from('sales_snapshots').select('sales').eq('day', day).eq('section', '*').order('taken_at', { ascending: false }).limit(1);
    const t2 = Math.round(fresh * 100) / 100;
    if (fresh > 0 && (!lastT?.length || Math.abs(Number(lastT[0].sales) - t2) >= 0.005)) {
      const taken_at = new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString();
      await db.from('sales_snapshots').upsert([{ day, taken_at, section: '*', section_desc: 'Whole store', sales: t2, qty: 0 }]);
      return { day, changed: true, stale: true, totalOnly: true, total: t2 };
    }
    return { day, changed: false, stale: true, total: t2 };
  }
  const secs = new Map<string, { section: string; section_desc: string; sales: number; qty: number }>();
  rows.forEach(r => { const c = String(r.section ?? '').trim() || '?'; const x = secs.get(c) || { section: c, section_desc: String(r.section_desc ?? '').trim() || (c === '?' ? 'Not classified' : c), sales: 0, qty: 0 };
    x.sales += Number(r.total_sales || 0); x.qty += Number(r.total_quantity || 0); secs.set(c, x); });
  const list = [...secs.values()], total = { section: '*', section_desc: 'Whole store', sales: list.reduce((t, x) => t + x.sales, 0), qty: list.reduce((t, x) => t + x.qty, 0) };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const { data: last } = await db.from('sales_snapshots').select('sales, qty').eq('day', day).eq('section', '*').order('taken_at', { ascending: false }).limit(1);
  if (last?.length && Math.abs(Number(last[0].sales) - total.sales) < 0.005 && Math.abs(Number(last[0].qty) - total.qty) < 0.0005) return { day, changed: false, total: r2(total.sales) };
  const taken_at = new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString();
  const { error } = await db.from('sales_snapshots').upsert([total, ...list].map(x => ({ day, taken_at, section: x.section, section_desc: x.section_desc, sales: r2(x.sales), qty: Math.round(x.qty * 1000) / 1000 })));
  if (error) throw error;
  return { day, changed: true, total: r2(total.sales), sections: list.length };
}
// every supplier: purchases vs sales in the period
// months (owner, 2026-10-06, the rental spots' trend): each supplier's sales per month too, when asked
async function perfSuppliers(from: string, to: string, months = false) {
  const [p, sl] = await Promise.all([report('purchases', from, to, { group_by: ['supplier'] }), report('sales', from, to, { group_by: ['supplier'] })]);
  const m = new Map<string, { code: string; name: string; bought: number; boughtQty: number; sold: number; soldQty: number }>();
  const get = (r: Record<string, unknown>) => { const c = String(r.supplier ?? '').trim() || '?'; let x = m.get(c); if (!x) { x = { code: c, name: String(r.supplier_desc ?? '').trim() || 'No supplier', bought: 0, boughtQty: 0, sold: 0, soldQty: 0 }; m.set(c, x); } return x; };
  p.forEach(r => { const x = get(r); x.bought += Number(r.total_purchases || 0); x.boughtQty += Number(r.total_quantity || 0); });
  sl.forEach(r => { const x = get(r) as { sold: number; soldQty: number; months?: Record<string, number> }; const v = Number(r.total_sales || 0); x.sold += v; x.soldQty += Number(r.total_quantity || 0);
    if (months) { const k = String(r.period || '').slice(0, 7); if (k) { x.months = x.months || {}; x.months[k] = (x.months[k] || 0) + v; } } });
  return { from, to, suppliers: [...m.values()] };
}
// one supplier: per item and per month
async function perfSupplier(sup: string, from: string, to: string) {
  // cats (owner, 2026-10-13): the supplier's sales item by item with each item's department, section, group, sub-group and
  // brand, so the page shows what sells most at every level and its share of the supplier's sales
  const [p, sl, cr] = await Promise.all([report('purchases', from, to, { group_by: ['item'], supplier: [sup] }), report('sales', from, to, { group_by: ['item'], supplier: [sup] }),
    report('sales', from, to, { group_by: ['item', 'department', 'section', 'group', 'subgroup', 'brand'], supplier: [sup] }).catch(e => { console.warn('perf cats', e); return null; })]);
  const nm = (r: Record<string, unknown>, k: string) => String(r[k + '_desc'] ?? '').trim() || String(r[k] ?? '').trim() || 'Not classified';
  const cats = cr ? cr.map(r => ({ code: String(r.item ?? '').trim(), description: String(r.item_desc ?? '').trim(), department: nm(r, 'department'), section: nm(r, 'section'),
    group: nm(r, 'group'), subgroup: nm(r, 'subgroup'), brand: nm(r, 'brand'), sales: Number(r.total_sales || 0), qty: Number(r.total_quantity || 0) })).filter(x => x.code) : null;
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
  return { from, to, supplier: sup, items: list, months, cats };
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
// the suppliers with a return (PT) in the last days (owner, 2026-10-14: a badge on each vendor card), from one report:
// an item returned on a day shows as a negative quantity (a return netted to 0 with a delivery the same day is not seen)
async function recentReturns(days = 7) {
  const to = beirutToday(), from = plusDays(to, -(days - 1));
  const out: Record<string, { code: string; name: string; days: string[]; items: number; value: number }> = {};
  for (const [f, t] of byYear(from, to)) {
    const d = await dash('/items_purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Daily', group_by: ['item', 'supplier'] }) });
    branchRows(d).forEach(r => {
      if (Number(r.total_quantity || 0) >= 0) return;
      const c = trimCode(r.supplier); if (!c) return;
      const x = out[c] = out[c] || { code: c, name: String(r.supplier_desc ?? '').trim(), days: [], items: 0, value: 0 };
      const day = String(r.period || '').slice(0, 10); if (day && !x.days.includes(day)) x.days.push(day);
      x.items++; x.value += Math.abs(Number(r.total_purchases || 0));
    });
  }
  Object.values(out).forEach(x => { x.days.sort().reverse(); x.value = Math.round(x.value * 100) / 100; });
  return { from, to, suppliers: Object.values(out) };
}
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
/* ---------------- a supplier's returns, PT by PT (owner, 2026-10-11: vendor sheet › Returns) ----------------
   The returns are the negative quantities of the supplier's purchases report (day by day, its items). Each return day:
   one item's cardex gives the PT number(s), the PT itself (document viewer, operation 20) gives all its lines, so the other
   items of that PT need no more reading. A PT made to another supplier (another code / name) is left out. */
async function readPt(code: string, yr: string) {
  const m = /^([A-Z]+)(\d+)$/.exec(code); if (!m) return null;
  const d = await dash('/operations/viewer', postJson({ year: yr, branch: BRANCH, document_type: m[1], document_number: m[2], operation_code: '20' })) as Record<string, unknown>;
  const v = d?.data as Record<string, unknown> | undefined;
  return v && Array.isArray(v.lines) ? v : null;
}
async function vendorPts(sups: string[], names: string[], from: string, to: string) {
  const want = new Set(sups.map(trimCode)), wantNames = new Set(names.map(supNameKey).filter(Boolean));
  const rows = await report('purchases', from, to, { aggregation: 'Daily', group_by: ['item'], supplier: sups });
  // per day: the items whose quantity is negative or 0 (a PT for sure: more returned than delivered that day, or a delivery
  // returned the same day - Junet PT0001243 / PU0004096 on 13-05 nets to 0), and the day's main delivered item (a PT of part
  // of a delivery leaves a positive quantity: its item card is read in case the PT holds that item)
  const days = new Map<string, { sure: string[]; main: string; mainQty: number }>();
  rows.forEach(r => { const d = String(r.period || '').slice(0, 10), c = trimCode(r._yrItem ?? r.item), q = Number(r.total_quantity || 0);
    if (!d || !c) return; const x = days.get(d) || { sure: [], main: '', mainQty: -1 };
    if (q <= 0) x.sure.push(c); else if (q > x.mainQty) { x.main = c; x.mainQty = q; }
    days.set(d, x); });
  const pts = new Map<string, Record<string, unknown>>(), seen = new Set<string>();
  let reads = 0, truncated = false;
  const cardexDocs = async (c: string, day: string) => {
    reads++;
    try {
      const cx = await dash(`/item-cardex?${new URLSearchParams({ branch: BRANCH, item_code: c, year: day.slice(0, 4), from_date: day, to_date: day })}`) as Record<string, unknown>;
      return [...new Set(((((cx.data as Record<string, unknown>)?.rows || []) as Record<string, unknown>[])).filter(isReturn).map(r => String(r.document_no || '').trim()).filter(Boolean))];
    } catch (e) { console.warn('pt cardex', c, e); return [] as string[]; }
  };
  const readDoc = async (doc: string, day: string, left: Set<string>) => {
    const k = doc + day.slice(0, 4); if (seen.has(k)) return; seen.add(k);
    try {
      const v = await readPt(doc, day.slice(0, 4)); if (!v) return;
      const lines = v.lines as Record<string, unknown>[];
      lines.forEach(l => left.delete(trimCode(l.item_code)));
      const code = trimCode(v.customer_code), partner = String(v.partner_name || '').trim();
      if (!want.has(code) && !wantNames.has(supNameKey(partner))) return;   // a PT to another supplier
      pts.set(k, { pt: String(v.document_code || doc), year: day.slice(0, 4), date: String(v.document_date || day).slice(0, 10), partner, supplierCode: code,
        currency: String(v.currency || ''), lines: lines.length, qty: lines.reduce((t, l) => t + Number(l.quantity || 0), 0),
        refs: [...new Set(lines.map(l => String(l.reference_no || '').trim()).filter(Boolean))],
        withoutVat: Number(v.total_without_vat || 0), vat: Number(v.vat_amount || 0), withVat: Number(v.total_with_vat || 0) });
    } catch (e) { console.warn('pt read', doc, e); }
  };
  const doDay = async (day: string, x: { sure: string[]; main: string }) => {
    const left = new Set(x.sure);
    for (const c of x.sure) { if (!left.has(c)) continue; left.delete(c); for (const doc of await cardexDocs(c, day)) await readDoc(doc, day, left); }
    if (x.main) for (const doc of await cardexDocs(x.main, day)) await readDoc(doc, day, new Set());
  };
  const list = [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const started = Date.now();
  for (let i = 0; i < list.length; i += 6) {
    if (reads >= 160 || Date.now() - started > 80000) { truncated = true; break; }   // the newest days first; the rest said to be missing
    await Promise.all(list.slice(i, i + 6).map(([d, x]) => doDay(d, x)));
  }
  return { from, to, pts: [...pts.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.pt).localeCompare(String(a.pt))), truncated, days: days.size };
}
// one PT, its lines in the system's order (codes of a past year turned into today's, for the item details)
async function ptDetail(code: string, yr: string) {
  const v = await readPt(code, yr);
  if (!v) return null;
  const lines = (v.lines as Record<string, unknown>[]).map((l, i) => ({ line: Number(l.line_number) || i + 1, code: trimCode(l.item_code), description: String(l.item_description || '').trim(),
    qty: Number(l.quantity || 0), unit: Number(l.unit_price || 0), disc: Number(l.unit_discount_percent || 0), net: Number(l.net_unit_price || 0),
    withoutVat: Number(l.total_without_vat || 0), vat: Number(l.vat_amount || 0), withVat: Number(l.total_with_vat || 0), remarks: String(l.remarks || '').trim(), ref: String(l.reference_no || '').trim(), today: '' }))
    .sort((a, b) => a.line - b.line);
  try { const m = await fromYear('item', lines.map(l => l.code), yr); lines.forEach(l => { l.today = m[l.code] || (yr === year() ? l.code : ''); }); } catch { lines.forEach(l => { l.today = yr === year() ? l.code : ''; }); }
  return { pt: String(v.document_code || code), year: yr, date: String(v.document_date || '').slice(0, 10), partner: String(v.partner_name || '').trim(), supplierCode: trimCode(v.customer_code),
    currency: String(v.currency || ''), discountPct: Number(v.total_percent_discount || 0), withoutVat: Number(v.total_without_vat || 0), vat: Number(v.vat_amount || 0),
    withVat: Number(v.total_with_vat || 0), qty: Number(v.total_quantity || 0), lines };
}
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
        if (hit) { if (cc !== c) it.currentCode = cc; it.promoted = !!Number(hit.isPromoted || 0); it.salePrice = unitSale(hit); it.saleCurrency = String(hit.CurrencyCode) === '01' ? 'LBP' : '$'; it.pack = hit.Pack ?? null; it.stockNow = hit.AvailableQuantity ?? null; it.pcBarcode = String(hit.Barcode ?? '').trim(); }
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

  // A supplier report by its private link (migration 091): no sign-in, the token is the key; read only, nothing else is given.
  if (body.action === 'supplier_report_view') {
    const tk = String(body.token || '');
    if (!/^[0-9a-f]{24,64}$/.test(tk)) return json({ error: 'This link is not valid.' }, 400);
    const { data, error } = await db.from('supplier_reports').select('vendor_name, month, data, created_at').eq('token', tk).maybeSingle();
    if (error || !data) return json({ error: 'This report was not found.' }, 404);
    return json(data);
  }

  // Returns tracker sync (migration 095), from pg_cron or the server key.
  if (body.action === 'pts_sync') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await ptsSync(String(body.from || '') || undefined, String(body.to || '') || undefined)); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // Auto-receive from a new PU (migration 094), from pg_cron or the server key.
  if (body.action === 'auto_receive') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await autoReceive()); }
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

  // The weekly report (migration 089), from pg_cron or the server key (a given week: body.week, its Monday).
  if (body.action === 'weekly_report' && (req.headers.get('x-cron-secret') || serverKeys().includes(req.headers.get('apikey') || ''))) {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await weeklyReport(String(body.week || '') || undefined)); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // Margin watch (migration 087), from pg_cron or the server key.
  if (body.action === 'margin_watch') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await marginWatch(isDay(String(body.day || '')) ? String(body.day) : undefined, Math.min(200, Number(body.budget) || 60), serverKeys().includes(req.headers.get('apikey') || '') && /^\d{4}-\d{2}-\d{2}T/.test(String(body.since || '')) ? String(body.since) : '')); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // Sales by hour (migration 086), from pg_cron or the server key.
  if (body.action === 'sales_snapshot') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await salesSnapshot()); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // Big purchases (migration 071), from pg_cron or the server key.
  if (body.action === 'big_buys') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await bigBuys()); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // Top sales (migration 073), from pg_cron (every day) or the server key.
  if (body.action === 'top_sales') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await topSales(String(body.period || ""))); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // Daily stock snapshots (migration 076), from pg_cron (every 5 minutes at night) or the server key.
  if (body.action === 'stock_snapshot') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await stockSnapshot()); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // The system's purchase orders (migration 082), from pg_cron (every 30 minutes in the day) or the server key.
  if (body.action === 'po_sync') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await poSync()); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // Stock review (migration 075): overstock / slow movers, from pg_cron (every day) or the server key.
  if (body.action === 'stock_review') {
    const cron = req.headers.get('x-cron-secret') || '';
    let ok = serverKeys().includes(req.headers.get('apikey') || '');
    if (!ok && cron) { const { data } = await db.rpc('push_keys'); ok = !!data && cron === (data as Record<string, string>).push_cron_secret; }
    if (!ok) return json({ error: 'Not allowed.' }, 403);
    try { return json(await stockReview(String(body.kind || ''))); }
    catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : 'failed' }, 502); }
  }

  // who is asking: a signed-in, active app user (or the server itself, for "status")
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const apikey = req.headers.get('apikey') || '';
  const isServer = (!!bearer && serverKeys().includes(bearer)) || (!!apikey && serverKeys().includes(apikey));
  let role = '';
  if (!isServer) {
    const { data: u, error: uErr } = await db.auth.getUser(bearer);
    if (!u?.user) return json({ error: 'Sign in first.' + (uErr ? ' (' + uErr.message + (bearer ? '' : ' — no session sent') + ')' : bearer ? '' : ' (no session sent)') }, 401);
    const { data: prof } = await db.from('profiles').select('role, active').eq('id', u.user.id).maybeSingle();
    if (!prof?.active) return json({ error: 'Not allowed.' }, 403);
    role = prof.role || '';
  }

  try {
    // One step of the stock snapshot now (admin, the Stock control page): the list, a batch, the movements.
    if (body.action === 'stock_snapshot_now') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      return json(await stockSnapshot());
    }
    // Recount the overstock / slow movers now (admin, the Stock control page).
    if (body.action === 'stock_review_now') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      return json(await stockReview(String(body.kind || '')));
    }
    // Recount the top sales now (admin, the Stock control page's Top sales).
    if (body.action === 'top_sales_now') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      return json(await topSales(String(body.period || "")));
    }
    // Read the system's purchase orders now (admin, Stock control › Low stock).
    if (body.action === 'po_sync_now') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      return json(await poSync());
    }
    // The store's profit of a month (admin only; migration 090)
    if (body.action === 'month_profit') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      const mo = String(body.month || '');
      if (!/^\d{4}-\d{2}/.test(mo)) return json({ error: 'Which month?' }, 400);
      return json(await monthProfit(mo));
    }
    // The weekly report made again now (an admin, Performance › Weekly report: a week's Monday)
    if (body.action === 'weekly_report') {
      if (role !== 'admin') return json({ error: 'Admin only.' }, 403);
      return json(await weeklyReport(String(body.week || '') || undefined));
    }
    // The store map's sales (owner, 2026-10-12; migration 088): who may open the map; amounts only for vendors.manage
    // (the floor manager gets each line's share of the period, no money).
    if (body.action === 'map_sales' || body.action === 'cat_tree') {
      let money = isServer || role === 'admin', allowed = money;
      if (!allowed) {
        const asUser = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false, autoRefreshToken: false } });
        const [{ data: m }, { data: a }] = await Promise.all([asUser.rpc('has_perm', { p_perms: ['vendors.manage'] }), asUser.rpc('has_perm', { p_perms: ['rentals.map', 'rentals.view', 'rentals.layout'] })]);
        money = !!m; allowed = !!m || !!a;
      }
      if (!allowed) return json({ error: 'Not allowed.' }, 403);
      if (body.action === 'cat_tree') { if (!money) return json({ error: 'Not allowed.' }, 403); return json(await catTree()); }
      const f = String(body.from || ''), t = String(body.to || '');
      if (!isDay(f) || !isDay(t) || f > t || Number(t.slice(0, 4)) - Number(f.slice(0, 4)) > 1) return json({ error: 'Choose dates within two years.' }, 400);
      const d = await mapSales(f, t);
      if (money) return json({ ...d, money: true });
      const total = d.rows.reduce((x, r) => x + r.sales, 0) || 1;
      return json({ from: d.from, to: d.to, money: false, rows: d.rows.map(r => ({ dep: r.dep, sec: r.sec, grp: r.grp, sub: r.sub, share: Math.round(r.sales / total * 1e6) / 1e6, qty: r.qty })) });
    }
    // Check one watched vendor's stock now (admin, the Vendors page's Check now).
    if (body.action === 'stock_check_now') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      return json(await stockWatch(String(body.vendor || '')));
    }
    // Sales across all branches, admin / vendors.manage (owner, 2026-10-13)
    if (body.action === 'branch_sales') {
      if (!isServer && role !== 'admin') {
        const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
        const asUser = createClient(SUPABASE_URL, anon, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false, autoRefreshToken: false } });
        const { data: ok } = await asUser.rpc('has_perm', { p_perms: ['vendors.manage'] });
        if (!ok) return json({ error: 'Not allowed.' }, 403);
      }
      return json(await branchSales(String(body.day || '')));
    }
    // The system's supplier catalogue, to import vendors from it (owner, 2026-10-13)
    if (body.action === 'supplier_catalog') {
      if (!isServer && role !== 'admin') {
        const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
        const asUser = createClient(SUPABASE_URL, anon, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false, autoRefreshToken: false } });
        const { data: ok } = await asUser.rpc('has_perm', { p_perms: ['vendors.manage'] });
        if (!ok) return json({ error: 'Not allowed.' }, 403);
      }
      return json(await supplierCatalog());
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
    // Server key or an admin (maintenance): one read-only report, as the dashboard answers it, to map its fields.
    if (body.action === 'probe') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      const path = String(body.path || '');
      const READ = /^\/(item-price-checker|item-cardex|items\/search|items\/filter-options\/[a-z]+|items_sales(\/grid|\/summary)?|items_purchases(\/grid)?|meta\/[a-z-]+|operations(\/[a-z_-]+)*|wms\/documents(\/\d+)?|wms\/purchase-orders)$/;
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
    if (['perf_suppliers', 'perf_supplier', 'store_daily', 'sales_categories', 'vendor_pts', 'pt_detail', 'supplier_report', 'promo_ideas', 'pricing_day', 'pricing_supplier', 'returns_range', 'recent_returns', 'pu_find', 'vendor_pos', 'pos_of_day', 'po_detail'].includes(String(body.action))) {
      if (!isServer && role !== 'admin') {
        const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
        const asUser = createClient(SUPABASE_URL, anon, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false, autoRefreshToken: false } });
        const { data: okPerm } = await asUser.rpc('has_perm', { p_perms: ['vendors.manage'] });
        if (!okPerm) return json({ error: 'Not allowed.' }, 403);
      }
      // a supplier's last POs, live from the system (the vendor sheet's POs tab)
      // promotion ideas (Pricing, owner 2026-10-12; migration 092): made again now
      if (body.action === 'promo_ideas') return json(await promoIdeas());
      // the monthly supplier report (vendor sheet, owner 2026-10-12; migration 091)
      if (body.action === 'supplier_report') {
        const sups = (Array.isArray(body.suppliers) ? body.suppliers : []).map(String).filter(Boolean).slice(0, 10);
        const mo = String(body.month || '');
        if (!sups.length) return json({ error: 'This vendor is not linked to its supplier in the system.' }, 400);
        if (!/^\d{4}-\d{2}/.test(mo)) return json({ error: 'Which month?' }, 400);
        return json(await supplierReportData(sups, mo));
      }
      // a supplier's returns (PTs) and one PT (vendor sheet › Returns, owner 2026-10-11)
      if (body.action === 'vendor_pts') {
        const sups = (Array.isArray(body.suppliers) ? body.suppliers : []).map(String).filter(Boolean).slice(0, 10);
        const names = (Array.isArray(body.names) ? body.names : []).map(String).filter(Boolean).slice(0, 10);
        if (!sups.length) return json({ error: 'This vendor is not linked to its supplier in the system.' }, 400);
        const pf = String(body.from || ''), pt = String(body.to || '');
        if (!isDay(pf) || !isDay(pt) || pf > pt || Number(pt.slice(0, 4)) - Number(pf.slice(0, 4)) > 1) return json({ error: 'Choose dates within two years.' }, 400);
        return json(await vendorPts(sups, names, pf, pt));
      }
      if (body.action === 'pt_detail') {
        const pt = String(body.pt || '').toUpperCase(), yr = String(body.year || '');
        if (!/^PT\d+$/.test(pt) || !/^\d{4}$/.test(yr)) return json({ error: 'Which PT?' }, 400);
        const d = await ptDetail(pt, yr);
        return d ? json(d) : json({ error: pt + ' was not found in ' + yr + '.' }, 404);
      }
      if (body.action === 'vendor_pos') {
        const sups = (Array.isArray(body.suppliers) ? body.suppliers : []).map(String).filter(Boolean).slice(0, 10);
        if (!sups.length) return json({ error: 'This vendor is not linked to its supplier in the system.' }, 400);
        return json(await vendorPos(sups, String(body.po || '')));
      }
      // the POs entered on a day, and one PO's lines (Vendors › POs)
      if (body.action === 'pos_of_day') {
        const d = String(body.day || '');
        if (!isDay(d) || d > beirutToday()) return json({ error: 'Choose a day.' }, 400);
        return json(await posOfDay(d));
      }
      if (body.action === 'po_detail') {
        const p = { po: String(body.po || ''), year: String(body.year || ''), po_date: String(body.po_date || ''), supplier_code: String(body.supplier_code || '') };
        if (!/^[A-Z]+\d+$/.test(p.po) || !/^\d{4}$/.test(p.year) || !isDay(p.po_date)) return json({ error: 'Which PO?' }, 400);
        return json(await poDetail(p));
      }
      const from = String(body.from || ''), to = String(body.to || ''), day = String(body.day || '');
      if (body.action === 'store_daily' || body.action === 'sales_categories') {
        if (!isDay(from) || !isDay(to) || from > to || Number(to.slice(0, 4)) - Number(from.slice(0, 4)) > 1) return json({ error: 'Choose dates within two years.' }, 400);
        if (body.action === 'store_daily') return json(await storeDaily(from, to));
        const level = String(body.level || 'section'), pl = body.parentLevel ? String(body.parentLevel) : '';
        if (!CAT_LEVELS.includes(level) || (pl && !CAT_LEVELS.includes(pl))) return json({ error: 'Unknown level.' }, 400);
        return json(await salesCategories(from, to, level, pl || undefined, body.parentCode ? String(body.parentCode) : undefined));
      }
      if (body.action === 'perf_suppliers' || body.action === 'perf_supplier') {
        if (!isDay(from) || !isDay(to) || from > to || Number(to.slice(0, 4)) - Number(from.slice(0, 4)) > 1) return json({ error: 'Choose dates within two years.' }, 400);
        if (body.action === 'perf_suppliers') return json(await perfSuppliers(from, to, body.months === true));
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
      if (body.action === 'recent_returns') return json(await recentReturns(7));
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
      return json({ item, raw: main, branches: branches.map(x => ({ branch: x.branch, found: !!x.hit, stock: x.hit ? (x.hit as Record<string, unknown>).AvailableQuantity ?? null : null,
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
              pack: hit.Pack ?? null, price: hit.Price ?? null, salePrice: unitSale(hit), promoted: !!Number(hit.isPromoted || 0), stock: hit.AvailableQuantity ?? null,
              currency: String(hit.CurrencyCode) === '01' ? 'LBP' : '$' } : null;
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
